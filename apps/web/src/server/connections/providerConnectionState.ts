import type { ConnectionCapability, Platform, PrismaClient, Prisma } from "../../generated/prisma/client";
import { CustomerAuth, digest, type CustomerPrincipal } from "../auth/customerAuth";
import { credentialContext, type OAuthRequest } from "./customerConnections";
import { CredentialVault } from "../security/credentialVault";
import { fail } from "../security/errors";

export type DiscoveredAccount = {
  externalId: string;
  name: string;
  currency?: string;
  timezone?: string;
  available: boolean;
  metadata: {
    manager?: boolean;
    status?: string;
    contexts?: { loginCustomerId: string | null }[];
    tasks?: string[];
    canRead: boolean;
    canWrite: "UNKNOWN" | "ALLOWED" | "DENIED";
  };
};

/** Trusted provider boundary. Credential snapshots must never be serialized to HTTP. */
export class ProviderConnectionState {
  constructor(private readonly db: PrismaClient, private readonly auth: CustomerAuth,
    private readonly vault: CredentialVault, private readonly now = () => new Date()) {}

  async grant(principal: CustomerPrincipal, id: string, provider: Platform,
    capability: ConnectionCapability = "ADS", reconnect = false) {
    await this.auth.assertSession(principal);
    const row = await this.db.providerAuthorization.findFirst({
      where: { id, userId: principal.userId, provider, capability },
    });
    if (!row) fail("NOT_FOUND", 404, "Connection not found.");
    if (!reconnect && (row.status !== "CONNECTED" || !row.accessCiphertext))
      fail("RECONNECT_REQUIRED", 409, "Reconnect this account before continuing.");
    return {
      id: row.id, providerUserId: row.providerUserId, connectionMode: row.connectionMode, scopes: row.scopes as string[],
      expiresAt: row.expiresAt, credentialVersion: row.credentialVersion,
      accessToken: row.accessCiphertext
        ? this.vault.decrypt(row.accessCiphertext, credentialContext(row.userId, row.id, "access")) : undefined,
      refreshToken: row.refreshCiphertext
        ? this.vault.decrypt(row.refreshCiphertext, credentialContext(row.userId, row.id, "refresh")) : undefined,
    };
  }

  async cancelOAuth(principal: CustomerPrincipal, state: string, expected: OAuthRequest, exchangeClaimToken?: string) {
    await this.auth.assertSession(principal);
    await this.db.oAuthAttempt.updateMany({ where: {
      stateHash: digest(state), userId: principal.userId, sessionId: principal.sessionId,
      provider: expected.provider, capability: expected.capability,
      redirectUri: expected.redirectUri, consumedAt: null,
      exchangeClaimHash: exchangeClaimToken === undefined ? null : digest(exchangeClaimToken),
    }, data: { consumedAt: this.now(), verifierCiphertext: null, exchangeClaimHash: null } });
  }

  async requireReconnect(principal: CustomerPrincipal, id: string, version: number) {
    await this.auth.assertSession(principal);
    await this.db.$transaction(async (tx) => {
      const current = await tx.providerAuthorization.findFirst({
        where: { id, userId: principal.userId, credentialVersion: version, status: "CONNECTED" },
      });
      if (!current) return;
      await tx.providerAuthorization.update({ where: { id }, data: {
        status: "RECONNECT_REQUIRED", accessCiphertext: null, refreshCiphertext: null,
        generation: { increment: 1 }, credentialVersion: { increment: 1 },
      } });
      await tx.oAuthAttempt.updateMany({ where: {
        userId: current.userId, provider: current.provider, capability: current.capability, consumedAt: null,
      }, data: { consumedAt: this.now(), verifierCiphertext: null, exchangeClaimHash: null } });
      await tx.connectionDestination.updateMany({ where: { authorizationId: id }, data: { selected: false } });
      await tx.connectionOperation.updateMany({ where: {
        destination: { authorizationId: id }, status: { in: ["PENDING", "RUNNING"] },
      }, data: { status: "CANCELLED", completedAt: this.now() } });
      await tx.connectionAuditEvent.create({ data: { authorizationId: id, action: "RECONNECT_REQUIRED" } });
    });
  }

  async recordMetaAccount(principal: CustomerPrincipal, id: string, version: number,
    destinationId: string, account: DiscoveredAccount) {
    await this.auth.assertSession(principal);
    await this.db.$transaction(async (tx) => {
      const destination = await tx.connectionDestination.findFirst({ where: {
        id: destinationId, authorizationId: id, externalId: account.externalId, kind: "AD_ACCOUNT",
        authorization: { userId: principal.userId, provider: "META", capability: "ADS",
          status: "CONNECTED", credentialVersion: version },
      } });
      if (!destination) fail("STALE_CREDENTIALS", 409, "The account or connection changed during its access check.");
      const denied = !account.available || account.metadata.canWrite === "DENIED";
      await tx.connectionDestination.update({ where: { id: destinationId }, data: {
        name: account.name, currency: account.currency, timezone: account.timezone,
        available: account.available, lastCheckedAt: this.now(),
        metadata: { canRead: account.metadata.canRead, canWrite: account.metadata.canWrite,
          ...(account.metadata.status ? { status: account.metadata.status } : {}),
          ...(account.metadata.tasks ? { tasks: account.metadata.tasks } : {}) },
        ...(denied ? { selected: false } : {}),
      } });
      if (denied)
        await tx.connectionOperation.updateMany({ where: { destinationId, status: { in: ["PENDING", "RUNNING"] } },
          data: { status: "CANCELLED", completedAt: this.now() } });
    });
  }

  async selectMetaAccount(principal: CustomerPrincipal, id: string, version: number, destinationId: string) {
    await this.auth.assertSession(principal);
    await this.db.$transaction(async (tx) => {
      const destination = await tx.connectionDestination.findFirst({ where: {
        id: destinationId, authorizationId: id, available: true, kind: "AD_ACCOUNT",
        authorization: { userId: principal.userId, provider: "META", capability: "ADS",
          status: "CONNECTED", credentialVersion: version },
      } });
      if (!destination) fail("STALE_CREDENTIALS", 409, "The destination or connection changed during selection.");
      const metadata = destination.metadata as { canWrite?: string } | null;
      if (metadata?.canWrite !== "ALLOWED")
        fail("PROVIDER_PERMISSION_DENIED", 403, "This Meta account does not grant advertising management access.");
      await tx.connectionDestination.update({ where: { id: destinationId }, data: { selected: true } });
      await tx.connectionOperation.updateMany({ where: { destinationId, status: { in: ["PENDING", "RUNNING"] } },
        data: { status: "CANCELLED", completedAt: this.now() } });
    });
  }

  async selectGoogleContext(principal: CustomerPrincipal, id: string, version: number,
    destinationId: string, loginCustomerId: string | null, verified: DiscoveredAccount) {
    await this.auth.assertSession(principal);
    const available = await this.db.$transaction(async (tx) => {
      const destination = await tx.connectionDestination.findFirst({ where: {
        id: destinationId, authorizationId: id, available: true, kind: "AD_ACCOUNT",
        authorization: { userId: principal.userId, provider: "GOOGLE", capability: "ADS",
          status: "CONNECTED", credentialVersion: version },
      } });
      if (!destination) fail("STALE_CREDENTIALS", 409, "The destination or connection changed during selection.");
      const metadata = destination.metadata as { contexts?: { loginCustomerId: string | null }[] } | null;
      if (!metadata?.contexts?.some((c) => c.loginCustomerId === loginCustomerId))
        fail("INVALID_ACCOUNT_CONTEXT", 403, "This manager context does not belong to the connected account.");
      if (verified.externalId !== destination.externalId ||
        !verified.metadata.contexts?.some((c) => c.loginCustomerId === loginCustomerId))
        fail("INVALID_ACCOUNT_CONTEXT", 403, "The verified account or manager context changed during selection.");
      const available = verified.available && verified.metadata.manager !== true && verified.metadata.status === "ENABLED";
      const freshMetadata: Prisma.InputJsonObject = {
        canRead: verified.metadata.canRead,
        canWrite: verified.metadata.canWrite,
        manager: verified.metadata.manager ?? false,
        ...(verified.metadata.status ? { status: verified.metadata.status } : {}),
        contexts: verified.metadata.contexts.map((context) => ({ loginCustomerId: context.loginCustomerId })),
      };
      await tx.connectionDestination.update({ where: { id: destinationId },
        data: { selected: available, available, selectedContext: { loginCustomerId },
          name: verified.name, currency: verified.currency, timezone: verified.timezone,
          metadata: freshMetadata, lastCheckedAt: this.now() } });
      await tx.connectionOperation.updateMany({ where: { destinationId, status: { in: ["PENDING", "RUNNING"] } },
        data: { status: "CANCELLED", completedAt: this.now() } });
      return available;
    });
    // Commit fresh unavailability and cancellation before returning the error;
    // throwing inside the transaction would resurrect the cached enabled state.
    if (!available)
      fail("ACCOUNT_NOT_AVAILABLE", 409, "Google reports this advertiser is not enabled. Review its status and refresh accounts before selecting it.");
  }

  async synchronize(principal: CustomerPrincipal, id: string, version: number, accounts: DiscoveredAccount[]) {
    await this.auth.assertSession(principal);
    if (accounts.length > 5000 || new Set(accounts.map((a) => a.externalId)).size !== accounts.length)
      fail("INVALID_DISCOVERY", 502, "Provider discovery returned too many or duplicate accounts.");
    await this.db.$transaction(async (tx) => {
      const current = await tx.providerAuthorization.findFirst({ where: {
        id, userId: principal.userId, capability: "ADS", status: "CONNECTED", credentialVersion: version,
      } });
      if (!current) fail("STALE_CREDENTIALS", 409, "The connection changed during account discovery.");
      const missing = await tx.connectionDestination.findMany({ where: {
        authorizationId: id, kind: "AD_ACCOUNT", externalId: { notIn: accounts.map((a) => a.externalId) },
      }, select: { id: true } });
      await tx.connectionDestination.updateMany({ where: { id: { in: missing.map((a) => a.id) } },
        data: { available: false, selected: false, lastCheckedAt: this.now() } });
      for (const account of accounts) {
        // Explicit whitelist: discovered token/identity payloads cannot enter public metadata.
        const metadata: Prisma.InputJsonObject = {
          canRead: account.metadata.canRead, canWrite: account.metadata.canWrite,
          ...(account.metadata.manager !== undefined ? { manager: account.metadata.manager } : {}),
          ...(account.metadata.status ? { status: account.metadata.status } : {}),
          ...(account.metadata.contexts ? { contexts: account.metadata.contexts.map((c) => ({ loginCustomerId: c.loginCustomerId })) } : {}),
          ...(account.metadata.tasks ? { tasks: account.metadata.tasks } : {}),
        };
        const previous = await tx.connectionDestination.findUnique({ where: { authorizationId_kind_externalId: {
          authorizationId: id, kind: "AD_ACCOUNT", externalId: account.externalId,
        } } });
        const context = previous?.selectedContext as { loginCustomerId: string | null } | null;
        const retained = context && account.metadata.contexts?.some((c) => c.loginCustomerId === context.loginCustomerId);
        const selectedContext = retained ? context : account.metadata.contexts?.[0];
        const data = { ...(selectedContext ? { selectedContext } : {}), name: account.name, currency: account.currency, timezone: account.timezone,
          available: account.available, metadata, lastCheckedAt: this.now() };
        await tx.connectionDestination.upsert({ where: { authorizationId_kind_externalId: {
          authorizationId: id, kind: "AD_ACCOUNT", externalId: account.externalId,
        } }, create: { authorizationId: id, kind: "AD_ACCOUNT", externalId: account.externalId, ...data },
          update: { ...data, ...(!account.available || account.metadata.canWrite === "DENIED" || (context && !retained) ? { selected: false } : {}) } });
      }
      await tx.connectionOperation.updateMany({ where: {
        destination: { authorizationId: id, OR: [{ available: false }, { selected: false }] }, status: { in: ["PENDING", "RUNNING"] },
      }, data: { status: "CANCELLED", completedAt: this.now() } });
      await tx.connectionAuditEvent.create({ data: { authorizationId: id, action: "DESTINATIONS_CHECKED" } });
    });
  }
}
