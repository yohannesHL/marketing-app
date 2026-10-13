import type { PrismaClient, Prisma } from "../../generated/prisma/client";
import { CustomerAuth, type CustomerPrincipal } from "../auth/customerAuth";
import { CustomerConnections } from "./customerConnections";
import { GoogleConnectionService } from "./googleConnectionApi";
import { MetaConnectionService } from "./metaConnectionApi";
import { googleConnectionService } from "./googleRuntime";
import { metaConnectionService } from "./metaRuntime";
import { GOOGLE_ADS_SCOPES } from "../providers/googleAds";
import { META_ADS_SCOPES, MetaProviderError } from "../providers/metaAds";
import { customerAuth, customerConnections } from "../security/runtime";
import { fail, privateJson, readBody, securityResponse, SecurityError } from "../security/errors";
import { prisma } from "../prisma/client";

type PaidProvider = "GOOGLE" | "META";
type Mode = "mock" | "live";
type Providers = {
  google: () => Pick<GoogleConnectionService, "readSmoke">;
  meta: () => Pick<MetaConnectionService, "readSmoke">;
};
type Account = { externalId: string; name: string; currency: string; timezone: string };
type Campaign = { externalId: string; name: string; status: string;
  impressions?: string; clicks?: string; costMicros?: string };
export type PaidReadOutcome = {
  destinationId: string;
  provider: PaidProvider;
  success: boolean;
  canRead: boolean;
  canWrite: "DISABLED";
  account?: Account;
  campaigns?: Campaign[];
  error?: { code: string; message: string; status: number };
};
type Snapshot = Readonly<{
  authorizationId: string; destinationId: string; provider: PaidProvider;
  externalId: string; credentialVersion: number; context: string;
}>;

function scopesFor(provider: PaidProvider): readonly string[] {
  return provider === "GOOGLE" ? GOOGLE_ADS_SCOPES : META_ADS_SCOPES;
}
function errorOutcome(error: unknown): NonNullable<PaidReadOutcome["error"]> {
  if (error instanceof SecurityError || error instanceof MetaProviderError)
    return { code: error.code, message: error.message, status: error.status };
  return { code: "PROVIDER_REQUEST_FAILED", message: "The selected account check could not be completed.", status: 502 };
}

/** Only explicitly selected, owned Ads destinations enter this immutable read boundary. */
export class PaidAccountRouting {
  constructor(private readonly auth: CustomerAuth, private readonly connections: CustomerConnections,
    private readonly providers: Providers, readonly mode: Mode, private readonly db: PrismaClient,
    private readonly now = () => new Date()) {}

  private context(provider: PaidProvider, destination: {
    selectedContext: unknown; metadata: unknown;
  }): string {
    if (provider === "META") return JSON.stringify(destination.selectedContext ?? null);
    const selected = destination.selectedContext as { loginCustomerId?: unknown } | null;
    const contexts = (destination.metadata as { contexts?: { loginCustomerId: string | null }[] } | null)?.contexts;
    if (!selected || !(selected.loginCustomerId === null ||
      (typeof selected.loginCustomerId === "string" && /^\d{1,20}$/.test(selected.loginCustomerId))) ||
      !contexts?.some((candidate) => candidate.loginCustomerId === selected.loginCustomerId))
      fail("INVALID_ACCOUNT_CONTEXT", 409, "Select a discovered manager context before reading this account.");
    return JSON.stringify({ loginCustomerId: selected.loginCustomerId });
  }

  private validGrant(grant: { capability: string; provider: string; connectionMode: string; status: string; scopes: unknown }) {
    if (grant.capability !== "ADS" || !["GOOGLE", "META"].includes(grant.provider))
      fail("UNSUPPORTED_PLATFORM", 400, "Choose an implemented paid advertising destination.");
    if (grant.connectionMode !== this.mode.toUpperCase())
      fail("CONNECTION_MODE_MISMATCH", 409, "Choose a connection belonging to the current provider mode.");
    if (grant.status !== "CONNECTED") fail("RECONNECT_REQUIRED", 409, "Reconnect the selected ad account.");
    const actual = grant.scopes as string[];
    if (!Array.isArray(actual) || scopesFor(grant.provider as PaidProvider).some((scope) => !actual.includes(scope)))
      fail("MISSING_PERMISSION", 403, "Reconnect and grant the permissions required to read this account.");
  }

  private async check(principal: CustomerPrincipal, snapshot: Snapshot, expectedVersion: number) {
    await this.auth.assertSession(principal);
    const grant = await this.connections.get(principal, snapshot.authorizationId);
    this.validGrant(grant);
    const destination = grant.destinations.find((item) => item.id === snapshot.destinationId);
    if (!destination || destination.kind !== "AD_ACCOUNT" || !destination.selected || !destination.available)
      fail("ACCOUNT_UNAVAILABLE", 409, "The selected destination is no longer available. Review the account selection.");
    if (grant.provider !== snapshot.provider || destination.externalId !== snapshot.externalId ||
        grant.credentialVersion !== expectedVersion || this.context(snapshot.provider, destination) !== snapshot.context)
      fail("STALE_CREDENTIALS", 409, "The connection or manager context changed during this check.");
    if (grant.expiresAt && grant.expiresAt <= this.now())
      fail("RECONNECT_REQUIRED", 409, "Renew the selected provider authorization before reading this account.");
  }

  async readSelected(principal: CustomerPrincipal, destinationIds: string[]) {
    await this.auth.assertSession(principal);
    if (!Array.isArray(destinationIds) || destinationIds.length === 0 || destinationIds.length > 25 ||
      destinationIds.some((id) => typeof id !== "string" || !id || id.trim() !== id || id.length > 512) ||
      new Set(destinationIds).size !== destinationIds.length)
      fail("INVALID_SELECTION", 400, "Supply between one and 25 distinct selected destination IDs.");
    const grants = await this.connections.list(principal);
    // Complete every ownership/capability/mode/selection preflight before any
    // provider call. An invalid ID never means all available accounts.
    const snapshots = destinationIds.map((id): Snapshot => {
      const grant = grants.find((item) => item.destinations.some((destination) => destination.id === id));
      if (!grant) fail("NOT_FOUND", 404, "Selected destination not found.");
      this.validGrant(grant);
      const destination = grant.destinations.find((item) => item.id === id)!;
      if (destination.kind !== "AD_ACCOUNT" || !destination.selected || !destination.available)
        fail("INVALID_SELECTION", 409, "Choose a selected, available ad account.");
      return Object.freeze({ authorizationId: grant.id, destinationId: id,
        provider: grant.provider as PaidProvider, externalId: destination.externalId,
        credentialVersion: grant.credentialVersion, context: this.context(grant.provider as PaidProvider, destination) });
    });
    const proofs: (number | undefined)[] = snapshots.map(() => undefined);
    const outcomes = await Promise.all(snapshots.map(async (snapshot, index): Promise<PaidReadOutcome> => {
      const base = { destinationId: snapshot.destinationId, provider: snapshot.provider, canWrite: "DISABLED" as const };
      try {
        // Google may renew an expired token inside its read boundary. That
        // boundary returns the exact version it used, rather than a fresh version
        // fetched afterward that could belong to a concurrent reconnect.
        await this.auth.assertSession(principal);
        const initial = await this.connections.get(principal, snapshot.authorizationId);
        this.validGrant(initial);
        const initialDestination = initial.destinations.find((item) => item.id === snapshot.destinationId);
        if (initial.provider !== snapshot.provider || initialDestination?.externalId !== snapshot.externalId ||
            initialDestination?.kind !== "AD_ACCOUNT" || !initialDestination.selected || !initialDestination.available ||
            initial.credentialVersion !== snapshot.credentialVersion ||
            this.context(snapshot.provider, initialDestination) !== snapshot.context)
          fail("STALE_CREDENTIALS", 409, "The account selection changed before this check.");
        if (snapshot.provider === "GOOGLE") {
          const result = await this.providers.google().readSmoke(principal, snapshot.authorizationId, snapshot.destinationId);
          await this.check(principal, snapshot, result.credentialVersion);
          if (result.mode !== this.mode || result.account.externalId !== snapshot.externalId ||
              result.account.manager || result.account.status !== "ENABLED")
            fail("ACCOUNT_UNAVAILABLE", 403, "This advertiser account is no longer available.");
          proofs[index] = result.credentialVersion;
          return { ...base, success: true, canRead: true,
            account: { externalId: result.account.externalId, name: result.account.name,
              currency: result.account.currency, timezone: result.account.timezone },
            campaigns: result.campaigns.map((campaign) => ({ externalId: campaign.externalId,
              name: campaign.name, status: campaign.status, impressions: campaign.impressions,
              clicks: campaign.clicks, costMicros: campaign.costMicros })) };
        }
        const result = await this.providers.meta().readSmoke(principal, snapshot.authorizationId, snapshot.destinationId);
        await this.check(principal, snapshot, result.credentialVersion);
        if (result.mode !== this.mode || result.account.externalId !== snapshot.externalId || result.account.accountStatus !== 1)
          fail("ACCOUNT_UNAVAILABLE", 403, "This ad account is no longer available.");
        proofs[index] = result.credentialVersion;
        return { ...base, success: true, canRead: true,
          account: { externalId: result.account.externalId, name: result.account.name,
            currency: result.account.currency, timezone: result.account.timezone },
          campaigns: result.campaigns.map((campaign) => ({ externalId: campaign.id, name: campaign.name, status: campaign.status })) };
      } catch (error) { return { ...base, success: false, canRead: false, error: errorOutcome(error) }; }
    }));
    const success = outcomes.every((outcome) => outcome.success);
    const partial = !success && outcomes.some((outcome) => outcome.success);
    const result = { mode: this.mode, writesEnabled: false as const, success, partial, outcomes };
    const execution = await this.db.$transaction(async (tx) => {
      // The authorization and session checks share the transaction with the
      // history insert. Deletion cannot finish and then have an in-flight read
      // recreate its erased account data through nullable audit linkage.
      const session = await tx.customerSession.findFirst({ where: {
        id: principal.sessionId, userId: principal.userId, expiresAt: { gt: this.now() },
      } });
      if (!session) fail("UNAUTHENTICATED", 401, "Sign in to continue.");
      for (const [index, snapshot] of snapshots.entries()) {
        const grant = await tx.providerAuthorization.findFirst({ where: {
          id: snapshot.authorizationId, userId: principal.userId, provider: snapshot.provider,
          capability: "ADS", connectionMode: this.mode.toUpperCase(),
        }, include: { destinations: true } });
        if (!grant) fail("STALE_CREDENTIALS", 409, "The connection changed during this check.");
        if (!outcomes[index].success) continue; // Failure history contains no provider account data.
        this.validGrant(grant);
        const destination = grant.destinations.find((item) => item.id === snapshot.destinationId);
        if (!destination?.selected || !destination.available || destination.kind !== "AD_ACCOUNT" ||
          destination.externalId !== snapshot.externalId || grant.credentialVersion !== proofs[index] ||
          this.context(snapshot.provider, destination) !== snapshot.context ||
          (grant.expiresAt && grant.expiresAt <= this.now()))
          fail("STALE_CREDENTIALS", 409, "The connection or selection changed during this check.");
      }
      return tx.adProxyExecution.create({ data: {
      ownerId: principal.userId, source: "paid-readiness", operation: "readCampaigns",
      requestPayload: { destinationIds }, responsePayload: result as Prisma.InputJsonValue,
      success, completedAt: this.now(), invocations: { create: snapshots.map((snapshot, index) => ({
        platform: snapshot.provider, authorizationId: snapshot.authorizationId,
        destinationId: snapshot.destinationId, connectionMode: this.mode.toUpperCase(),
        adapterPayload: { operation: "readCampaigns", destinationId: snapshot.destinationId,
          authorizationId: snapshot.authorizationId },
        downstreamResponse: outcomes[index] as Prisma.InputJsonValue,
        success: outcomes[index].success, errorMessage: outcomes[index].error?.message,
        completedAt: this.now(),
      })) },
      } });
    });
    return { ...result, executionId: execution.id };
  }
}

export function createPaidAccountRoutingApi(auth: CustomerAuth, routing: PaidAccountRouting) {
  return async (request: Request): Promise<Response> => {
    try {
      const principal = await auth.requireSession(request);
      auth.assertOrigin(request);
      if (request.method !== "POST") fail("METHOD_NOT_ALLOWED", 405, "Use POST to check selected ad accounts.");
      const body = await readBody(request);
      if (Object.keys(body).some((key) => key !== "destinationIds") || !Array.isArray(body.destinationIds))
        fail("INVALID_BODY", 400, "Supply only explicit selected destination IDs.");
      return privateJson(await routing.readSelected(principal, body.destinationIds as string[]));
    } catch (error) { return securityResponse(error); }
  };
}

export async function handlePaidAccountRoutingApi(request: Request) {
  try {
    const auth = customerAuth();
    await auth.requireSession(request);
    const mode = process.env.CONNECTION_MODE;
    if (mode !== "mock" && mode !== "live") fail("PROVIDER_DISABLED", 503, "Enable an explicit provider connection mode.");
    const routing = new PaidAccountRouting(auth, customerConnections(), {
      google: () => googleConnectionService(), meta: () => metaConnectionService(),
    }, mode, prisma);
    return await createPaidAccountRoutingApi(auth, routing)(request);
  } catch (error) { return securityResponse(error); }
}
