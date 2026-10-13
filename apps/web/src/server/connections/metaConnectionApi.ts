import { CustomerAuth, digest, type CustomerPrincipal } from "../auth/customerAuth";
import { CustomerConnections, type OAuthRequest } from "./customerConnections";
import { ProviderConnectionState, type DiscoveredAccount } from "./providerConnectionState";
import { MetaAdsClient, MetaProviderError, type MetaAdAccount } from "../providers/metaAds";
import { MetaSignedRequestError, verifyMetaSignedRequest } from "../providers/metaSignedRequests";
import { fail, privateJson, readBody, securityResponse } from "../security/errors";

export interface MetaLifecycleReceiver {
  deauthorize(signedSubject: string, event?: { eventId: string; issuedAt?: number }): Promise<void>;
  deleteData(signedSubject: string, event?: { eventId: string; issuedAt?: number }): Promise<{ url: string; confirmation_code: string }>;
  receipt(id: string): Promise<{ status: string }>;
}

function accountMetadata(row: MetaAdAccount): DiscoveredAccount {
  return { externalId: row.externalId, name: row.name, currency: row.currency,
    timezone: row.timezone, available: row.accountStatus === 1,
    metadata: { status: String(row.accountStatus), tasks: row.userTasks,
      canRead: true, canWrite: row.canManage ? "ALLOWED" : "DENIED" } };
}

export function metaProviderResponse(error: unknown) {
  if (error instanceof MetaProviderError)
    return privateJson({ code: error.code, message: error.message, retryable: error.retryable,
      ...(error.providerCode !== undefined ? { providerCode: error.providerCode } : {}) }, error.status);
  if (error instanceof MetaSignedRequestError)
    return privateJson({ code: error.code, message: error.message }, error.status);
  return securityResponse(error);
}

export class MetaConnectionService {
  readonly oauth: OAuthRequest;
  constructor(private readonly auth: CustomerAuth, private readonly connections: CustomerConnections,
    private readonly state: ProviderConnectionState, private readonly client: MetaAdsClient,
    readonly mode: "mock" | "live", private readonly now = () => new Date()) {
    this.oauth = { provider: "META", capability: "ADS", pkce: false,
      scopes: client.scopes, redirectUri: `${auth.origin}/api/connections/meta/callback` };
    if (client.redirectUri !== this.oauth.redirectUri)
      fail("INVALID_CONFIG", 503, "The Meta callback must match the configured application origin.");
  }

  async start(principal: CustomerPrincipal, reconnectAuthorizationId?: string) {
    if (reconnectAuthorizationId) {
      const previous = await this.state.grant(principal, reconnectAuthorizationId, "META", "ADS", true);
      if (previous.connectionMode !== this.mode.toUpperCase())
        fail("CONNECTION_MODE_MISMATCH", 409, "Create a new connection when switching provider modes.");
    }
    const attempt = await this.connections.beginOAuth(principal, { ...this.oauth, reconnectAuthorizationId });
    return { authorizationUrl: this.client.authorizationUrl(attempt.state), mode: this.mode };
  }

  async complete(principal: CustomerPrincipal, state: string, code?: string, denied = false, authorizationFailed = false) {
    // Claim outside the catch: a losing duplicate callback must not cancel the
    // attempt currently owned by the winning provider exchange.
    const context = await this.connections.claimOAuthExchange(principal, state, this.oauth);
    try {
      if (authorizationFailed) fail("PROVIDER_AUTHORIZATION_FAILED", 502, "Meta could not authorize this connection. Start again.");
      if (denied) fail("CONSENT_DENIED", 400, "Meta permission was declined. Connect again when ready.");
      if (!code || code.length > 4096) fail("INVALID_OAUTH_CODE", 400, "Restart the Meta connection.");
      const previous = context.reconnectAuthorizationId
        ? await this.state.grant(principal, context.reconnectAuthorizationId, "META", "ADS", true) : undefined;
      if (previous && previous.connectionMode !== this.mode.toUpperCase())
        fail("CONNECTION_MODE_MISMATCH", 409, "Create a new connection when switching provider modes.");
      const grant = await this.client.exchangeCode(code, previous?.providerUserId);
      // Discovery completes before consuming state. The foundation fences a
      // disconnect/removal arriving during either remote request.
      const discovered = await this.client.discoverAccounts(grant.accessToken);
      const connection = await this.connections.completeAuthorization(principal, state, this.oauth,
        { ...grant, connectionMode: this.mode === "mock" ? "MOCK" : "LIVE" }, context.exchangeClaimToken);
      await this.state.synchronize(principal, connection.id, connection.credentialVersion,
        discovered.map(accountMetadata));
      return { connection: await this.connections.get(principal, connection.id), mode: this.mode };
    } catch (error) {
      await this.state.cancelOAuth(principal, state, this.oauth, context.exchangeClaimToken);
      throw error;
    }
  }

  private async withCredentials<T>(principal: CustomerPrincipal, id: string,
    invoke: (snapshot: Awaited<ReturnType<ProviderConnectionState["grant"]>>) => Promise<T>) {
    const snapshot = await this.state.grant(principal, id, "META", "ADS");
    if (snapshot.connectionMode !== this.mode.toUpperCase())
      fail("CONNECTION_MODE_MISMATCH", 409, "This connection belongs to a different provider mode.");
    if (snapshot.expiresAt && snapshot.expiresAt <= this.now()) {
      await this.state.requireReconnect(principal, id, snapshot.credentialVersion);
      fail("RECONNECT_REQUIRED", 409, "Reconnect Meta to renew its authorization.");
    }
    if (this.client.scopes.some((scope) => !snapshot.scopes.includes(scope))) {
      await this.state.requireReconnect(principal, id, snapshot.credentialVersion);
      fail("MISSING_PERMISSION", 403, "Reconnect Meta and grant the required permissions.");
    }
    try {
      const result = await invoke(snapshot);
      const current = await this.state.grant(principal, id, "META", "ADS");
      if (current.credentialVersion !== snapshot.credentialVersion)
        fail("STALE_CREDENTIALS", 409, "The connection changed during this check.");
      return result;
    } catch (error) {
      if (error instanceof MetaProviderError &&
          ["RECONNECT_REQUIRED", "MISSING_PERMISSION", "SUBJECT_MISMATCH"].includes(error.code)) {
        await this.state.requireReconnect(principal, id, snapshot.credentialVersion);
      }
      throw error;
    }
  }

  async refreshAccounts(principal: CustomerPrincipal, id: string) {
    return this.withCredentials(principal, id, async (snapshot) => {
      const rows = await this.client.discoverAccounts(snapshot.accessToken!);
      await this.state.synchronize(principal, id, snapshot.credentialVersion, rows.map(accountMetadata));
      return { connection: await this.connections.get(principal, id), mode: this.mode };
    });
  }

  async selectAccount(principal: CustomerPrincipal, id: string, destinationId: string) {
    return this.withCredentials(principal, id, async (snapshot) => {
      const connection = await this.connections.get(principal, id);
      const destination = connection.destinations.find((d) => d.id === destinationId &&
        d.kind === "AD_ACCOUNT" && d.available);
      if (!destination) fail("NOT_FOUND", 404, "Choose an available ad account from this connection.");
      const account = await this.client.readAccount(snapshot.accessToken!, destination.externalId);
      await this.state.recordMetaAccount(principal, id, snapshot.credentialVersion, destinationId,
        accountMetadata(account));
      if (!account.canManage) fail("ACCOUNT_UNAVAILABLE", 403, "This account cannot manage campaigns.");
      await this.state.selectMetaAccount(principal, id, snapshot.credentialVersion, destinationId);
      return { connection: await this.connections.get(principal, id), mode: this.mode };
    });
  }

  async readSmoke(principal: CustomerPrincipal, id: string, destinationId: string) {
    return this.withCredentials(principal, id, async (snapshot) => {
      const connection = await this.connections.get(principal, id);
      const destination = connection.destinations.find((d) => d.id === destinationId &&
        d.kind === "AD_ACCOUNT" && d.available);
      if (!destination) fail("NOT_FOUND", 404, "Choose an available ad account from this connection.");
      const account = await this.client.readAccount(snapshot.accessToken!, destination.externalId);
      await this.state.recordMetaAccount(principal, id, snapshot.credentialVersion, destinationId,
        accountMetadata(account));
      return { mode: this.mode, canRead: true,
        canWrite: account.canManage ? "ALLOWED" : "DENIED", account };
    });
  }
}

async function signedSubject(request: Request, secret: string) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded"))
    fail("INVALID_BODY", 400, "A signed Meta form callback is required.");
  const reader = request.body?.getReader();
  if (!reader) fail("INVALID_BODY", 400, "A signed Meta form callback is required.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 32768) {
      await reader.cancel();
      fail("INVALID_BODY", 413, "The callback body is too large.");
    }
    chunks.push(value);
  }
  const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  if (body.getAll("signed_request").length !== 1)
    fail("INVALID_BODY", 400, "Supply one signed Meta request.");
  const value = body.get("signed_request")!;
  const verified = verifyMetaSignedRequest(value, secret);
  return { userId: verified.userId, event: { eventId: digest(value),
    ...(verified.issuedAt ? { issuedAt: verified.issuedAt.getTime() / 1000 } : {}) } };
}

export type MetaCallbackOptions = { appSecret: string; lifecycle?: MetaLifecycleReceiver };

/** Lifecycle dispatch is independent of the outbound provider client/configuration. */
export async function dispatchMetaLifecycle(request: Request, callbacks: MetaCallbackOptions): Promise<Response | null> {
  const url = new URL(request.url);
  if (["/api/connections/meta/deauthorize", "/api/connections/meta/data-deletion"].includes(url.pathname)) {
    if (request.method !== "POST") fail("METHOD_NOT_ALLOWED", 405, "Use POST for Meta callbacks.");
    const subject = await signedSubject(request, callbacks.appSecret);
    if (!callbacks.lifecycle) fail("LIFECYCLE_UNAVAILABLE", 503, "Meta lifecycle processing is unavailable.");
    if (url.pathname.endsWith("/deauthorize")) {
      await callbacks.lifecycle.deauthorize(subject.userId, subject.event);
      return privateJson({ success: true });
    }
    const receipt = await callbacks.lifecycle.deleteData(subject.userId, subject.event);
    return privateJson({ url: receipt.url, confirmation_code: receipt.confirmation_code });
  }
  const receipt = url.pathname.match(/^\/api\/connections\/meta\/deletion-status\/([A-Za-z0-9]{16,128})$/);
  if (receipt) {
    if (request.method !== "GET") fail("METHOD_NOT_ALLOWED", 405, "Use GET to check deletion status.");
    if (!callbacks.lifecycle) fail("LIFECYCLE_UNAVAILABLE", 503, "Meta lifecycle processing is unavailable.");
    const result = await callbacks.lifecycle.receipt(receipt[1]);
    if (request.headers.get("accept")?.includes("text/html")) {
      const status = result.status.replace(/[&<>"']/g, (char) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
      return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Meta data deletion</title><main><h1>Meta data deletion request</h1><p>Request status: ${status}.</p><p>This status concerns data held by this application.</p></main></html>`,
        { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }
    return privateJson({ status: result.status });
  }
  if (url.pathname.startsWith("/api/connections/meta/deletion-status/"))
    fail("NOT_FOUND", 404, "Deletion receipt not found.");
  return null;
}

export function createMetaConnectionApi(auth: CustomerAuth, service: MetaConnectionService,
  callbacks: MetaCallbackOptions) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const htmlCallback = url.pathname === "/api/connections/meta/callback" &&
      request.method === "GET" && request.headers.get("accept")?.includes("text/html");
    try {
      const lifecycleResponse = await dispatchMetaLifecycle(request, callbacks);
      if (lifecycleResponse) return lifecycleResponse;
      const principal = await auth.requireSession(request);
      if (url.pathname === "/api/connections/meta/callback" && request.method === "GET") {
        const result = await service.complete(principal, url.searchParams.get("state") ?? "",
          url.searchParams.get("code") ?? undefined, url.searchParams.get("error") === "access_denied",
          url.searchParams.has("error") && url.searchParams.get("error") !== "access_denied");
        if (htmlCallback) return new Response(null, { status: 303, headers: {
          Location: `${auth.origin}/connections?provider=meta&result=connected`, "Cache-Control": "no-store" } });
        return privateJson(result);
      }
      auth.assertOrigin(request);
      if (request.method !== "POST") fail("METHOD_NOT_ALLOWED", 405, "Use POST for connection actions.");
      const body = await readBody(request);
      if (url.pathname === "/api/connections/meta/start") {
        if (Object.keys(body).some((key) => key !== "authorizationId") ||
            (body.authorizationId !== undefined && typeof body.authorizationId !== "string"))
          fail("INVALID_BODY", 400, "Supply only an optional connection to reconnect.");
        return privateJson(await service.start(principal, body.authorizationId as string | undefined));
      }
      const match = url.pathname.match(/^\/api\/connections\/meta\/([^/]+)\/(refresh|check|select)$/);
      if (!match) fail("NOT_FOUND", 404, "Endpoint not found.");
      if (match[2] === "refresh") {
        if (Object.keys(body).length) fail("INVALID_BODY", 400, "Discovery does not accept provider credentials or IDs.");
        return privateJson(await service.refreshAccounts(principal, match[1]));
      }
      if (Object.keys(body).some((key) => key !== "destinationId") || typeof body.destinationId !== "string")
        fail("INVALID_BODY", 400, "Supply a destination from this connection.");
      return privateJson(match[2] === "select"
        ? await service.selectAccount(principal, match[1], body.destinationId)
        : await service.readSmoke(principal, match[1], body.destinationId));
    } catch (error) {
      if (htmlCallback) return new Response(null, { status: 303, headers: {
        Location: `${auth.origin}/connections?provider=meta&result=failed`, "Cache-Control": "no-store" } });
      return metaProviderResponse(error);
    }
  };
}
