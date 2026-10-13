import type { CustomerPrincipal } from "../auth/customerAuth";
import { CustomerAuth } from "../auth/customerAuth";
import { CustomerConnections, type OAuthRequest } from "./customerConnections";
import { ProviderConnectionState, type DiscoveredAccount } from "./providerConnectionState";
import { GoogleAdsClient, GOOGLE_ADS_SCOPES, type GoogleAdsDestination } from "../providers/googleAds";
import { ProviderHttpError } from "../providers/providerHttp";
import { fail, privateJson, readBody, securityResponse } from "../security/errors";

function accounts(rows: GoogleAdsDestination[]): DiscoveredAccount[] {
  return rows.map((row) => ({ externalId: row.externalId, name: row.name,
    currency: row.currency, timezone: row.timezone,
    available: !row.manager && row.status === "ENABLED",
    metadata: { manager: row.manager, status: row.status, contexts: row.contexts,
      canRead: true, canWrite: "UNKNOWN" } }));
}

export function providerResponse(error: unknown) {
  if (error instanceof ProviderHttpError)
    return privateJson({ code: error.code, message: error.message,
      details: error.details, requestId: error.requestId }, error.status);
  return securityResponse(error);
}

export class GoogleConnectionService {
  readonly oauth: OAuthRequest;
  constructor(private readonly auth: CustomerAuth, private readonly connections: CustomerConnections,
    private readonly state: ProviderConnectionState, private readonly client: GoogleAdsClient,
    readonly mode: "mock" | "live", private readonly now = () => new Date()) {
    this.oauth = { provider: "GOOGLE", capability: "ADS", pkce: true,
      scopes: GOOGLE_ADS_SCOPES, redirectUri: `${auth.origin}/api/connections/google/callback` };
  }

  async start(principal: CustomerPrincipal, reconnectAuthorizationId?: string) {
    const attempt = await this.connections.beginOAuth(principal, { ...this.oauth, reconnectAuthorizationId });
    return { authorizationUrl: this.client.authorizationUrl({ state: attempt.state,
      codeChallenge: attempt.codeChallenge! }), mode: this.mode };
  }

  async complete(principal: CustomerPrincipal, state: string, code?: string, denied = false, authorizationFailed = false) {
    const context = await this.connections.claimOAuthExchange(principal, state, this.oauth);
    try {
      if (authorizationFailed) fail("PROVIDER_AUTHORIZATION_FAILED", 502, "Google could not authorize this request. Start the connection again.");
      if (denied) fail("CONSENT_DENIED", 400, "Google permission was declined. Connect again when ready.");
      if (!code || code.length > 4096 || !context.codeVerifier)
        fail("INVALID_OAUTH_CODE", 400, "Restart the Google connection.");
      const previous = context.reconnectAuthorizationId
        ? await this.state.grant(principal, context.reconnectAuthorizationId, "GOOGLE", "ADS", true) : undefined;
      if (previous && previous.connectionMode !== this.mode.toUpperCase())
        fail("CONNECTION_MODE_MISMATCH", 409, "Create a new connection when switching between mock and live providers.");
      const grant = await this.client.exchangeCode({ code, codeVerifier: context.codeVerifier,
        ...(previous?.refreshToken ? { previous: { providerUserId: previous.providerUserId,
          refreshToken: previous.refreshToken } } : {}) });
      if (previous && previous.providerUserId !== grant.providerUserId)
        fail("PROVIDER_IDENTITY_MISMATCH", 409, "Choose the Google identity belonging to this connection.");
      // Do discovery before consuming/persisting the verified grant. A disconnect
      // during either provider call invalidates state and prevents reconnection.
      const discovered = await this.client.discoverAccounts(grant.accessToken);
      const connection = await this.connections.completeAuthorization(principal, state, this.oauth, { ...grant, connectionMode: this.mode === "mock" ? "MOCK" : "LIVE" }, context.exchangeClaimToken);
      await this.state.synchronize(principal, connection.id, connection.credentialVersion, accounts(discovered));
      return { connection: await this.connections.get(principal, connection.id), mode: this.mode };
    } catch (error) {
      await this.state.cancelOAuth(principal, state, this.oauth, context.exchangeClaimToken);
      throw error;
    }
  }

  private async credentials(principal: CustomerPrincipal, id: string, force = false) {
    let snapshot = await this.state.grant(principal, id, "GOOGLE");
    if (snapshot.connectionMode !== this.mode.toUpperCase())
      fail("CONNECTION_MODE_MISMATCH", 409, "This connection belongs to a different provider mode. Create a new connection.");
    if (force || (snapshot.expiresAt && snapshot.expiresAt.getTime() <= this.now().getTime() + 60_000)) {
      try {
        const renewed = await this.client.refreshGrant({ providerUserId: snapshot.providerUserId,
          refreshToken: snapshot.refreshToken ?? "", scopes: snapshot.scopes });
        await this.connections.updateCredentials(id, snapshot.credentialVersion, renewed);
      } catch (error) {
        if (error instanceof ProviderHttpError && ["RECONNECT_REQUIRED", "PROVIDER_IDENTITY_MISMATCH", "MISSING_PERMISSION"].includes(error.code))
          await this.state.requireReconnect(principal, id, snapshot.credentialVersion);
        throw error;
      }
      snapshot = await this.state.grant(principal, id, "GOOGLE");
    }
    return snapshot;
  }

  private async readWithCredentials<T>(principal: CustomerPrincipal, id: string,
    invoke: (snapshot: Awaited<ReturnType<ProviderConnectionState["grant"]>>) => Promise<T>) {
    let snapshot = await this.credentials(principal, id);
    try { return await invoke(snapshot); }
    catch (error) {
      if (!(error instanceof ProviderHttpError) || error.code !== "RECONNECT_REQUIRED") throw error;
      const current = await this.state.grant(principal, id, "GOOGLE");
      if (current.credentialVersion !== snapshot.credentialVersion)
        fail("STALE_CREDENTIALS", 409, "The connection changed during this check.");
      // One refresh/retry is safe for read-only calls; writes must never use this helper.
      snapshot = await this.credentials(principal, id, true);
      try { return await invoke(snapshot); }
      catch (retryError) {
        if (retryError instanceof ProviderHttpError && retryError.code === "RECONNECT_REQUIRED")
          await this.state.requireReconnect(principal, id, snapshot.credentialVersion);
        throw retryError;
      }
    }
  }

  async refreshAccounts(principal: CustomerPrincipal, id: string) {
    return this.readWithCredentials(principal, id, async (snapshot) => {
      const rows = await this.client.discoverAccounts(snapshot.accessToken!);
      await this.state.synchronize(principal, id, snapshot.credentialVersion, accounts(rows));
      return { connection: await this.connections.get(principal, id), mode: this.mode };
    });
  }

  async selectAccount(principal: CustomerPrincipal, id: string, destinationId: string, loginCustomerId: string | null) {
    return this.readWithCredentials(principal, id, async (snapshot) => {
      const connection = await this.connections.get(principal, id);
      const destination = connection.destinations.find((d) => d.id === destinationId && d.available);
      if (!destination) fail("NOT_FOUND", 404, "Choose an accessible advertiser in this connection.");
      const metadata = destination.metadata as { contexts?: { loginCustomerId: string | null }[] } | null;
      if (!metadata?.contexts?.some((c) => c.loginCustomerId === loginCustomerId))
        fail("INVALID_ACCOUNT_CONTEXT", 403, "Choose a manager context discovered for this account.");
      const verified = await this.client.verifyAccount(snapshot.accessToken!, { customerId: destination.externalId, loginCustomerId });
      await this.state.selectGoogleContext(principal, id, snapshot.credentialVersion, destinationId, loginCustomerId, accounts([verified])[0]);
      return { connection: await this.connections.get(principal, id), mode: this.mode };
    });
  }

  async readSmoke(principal: CustomerPrincipal, id: string, destinationId: string) {
    return this.readWithCredentials(principal, id, async (snapshot) => {
      const connection = await this.connections.get(principal, id);
      const destination = connection.destinations.find((d) => d.id === destinationId);
      if (!destination || destination.kind !== "AD_ACCOUNT")
        fail("NOT_FOUND", 404, "Choose an accessible advertiser account in this connection.");
      const metadata = destination.metadata as { contexts?: { loginCustomerId: string | null }[] } | null;
      if ((destination.metadata as { manager?: boolean } | null)?.manager)
        fail("NOT_FOUND", 404, "Choose an advertiser account for this check.");
      const selectedContext = destination.selectedContext as { loginCustomerId: string | null } | null;
      if (!metadata?.contexts?.length) fail("INVALID_ACCOUNT_CONTEXT", 409, "Refresh account discovery before checking this account.");
      const context = { customerId: destination.externalId, loginCustomerId: selectedContext ? selectedContext.loginCustomerId : metadata.contexts[0].loginCustomerId };
      const account = await this.client.verifyAccount(snapshot.accessToken!, context);
      const campaigns = await this.client.readCampaigns(snapshot.accessToken!, context);
      const current = await this.state.grant(principal, id, "GOOGLE");
      if (current.credentialVersion !== snapshot.credentialVersion)
        fail("STALE_CREDENTIALS", 409, "The connection changed during this check.");
      return { mode: this.mode, canRead: true, canWrite: "UNKNOWN", account, campaigns };
    });
  }

}

export function createGoogleConnectionApi(auth: CustomerAuth, service: GoogleConnectionService) {
  return async (request: Request) => {
    try {
      const principal = await auth.requireSession(request);
      const url = new URL(request.url);
      if (url.pathname === "/api/connections/google/callback" && request.method === "GET") {
        const result = await service.complete(principal, url.searchParams.get("state") ?? "",
          url.searchParams.get("code") ?? undefined, url.searchParams.get("error") === "access_denied",
          url.searchParams.has("error") && url.searchParams.get("error") !== "access_denied");
        if (request.headers.get("accept")?.includes("text/html"))
          return new Response(null, { status: 303, headers: { Location: `${auth.origin}/connections?provider=google&result=connected`, "Cache-Control": "no-store" } });
        return privateJson(result);
      }
      auth.assertOrigin(request);
      if (request.method !== "POST") fail("METHOD_NOT_ALLOWED", 405, "Use POST for connection actions.");
      const body = await readBody(request);
      if (url.pathname === "/api/connections/google/start") {
        if (Object.keys(body).some((key) => key !== "authorizationId") ||
          (body.authorizationId !== undefined && typeof body.authorizationId !== "string"))
          fail("INVALID_BODY", 400, "Supply only an optional connection to reconnect.");
        return privateJson(await service.start(principal, body.authorizationId as string | undefined));
      }
      const match = url.pathname.match(/^\/api\/connections\/google\/([^/]+)\/(refresh|check|select)$/);
      if (!match) fail("NOT_FOUND", 404, "Endpoint not found.");
      if (match[2] === "select") {
        if (Object.keys(body).some((key) => !["destinationId", "loginCustomerId"].includes(key)) ||
          typeof body.destinationId !== "string" || !(body.loginCustomerId === null ||
            (typeof body.loginCustomerId === "string" && /^\d{1,20}$/.test(body.loginCustomerId))))
          fail("INVALID_SELECTION", 400, "Supply a destination and its discovered manager context (or null for direct access).");
        return privateJson(await service.selectAccount(principal, match[1], body.destinationId, body.loginCustomerId as string | null));
      }
      if (match[2] === "refresh") {
        if (Object.keys(body).length) fail("INVALID_BODY", 400, "Account discovery does not accept provider IDs or credentials.");
        return privateJson(await service.refreshAccounts(principal, match[1]));
      }
      if (Object.keys(body).some((key) => key !== "destinationId") || typeof body.destinationId !== "string")
        fail("INVALID_BODY", 400, "Supply a destination from this connection.");
      return privateJson(await service.readSmoke(principal, match[1], body.destinationId));
    } catch (error) { return providerResponse(error); }
  };
}
