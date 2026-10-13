import { CustomerAuth, type CustomerPrincipal } from "../auth/customerAuth";
import { CustomerConnections, type OAuthRequest } from "./customerConnections";
import { ProviderConnectionState } from "./providerConnectionState";
import { SocialConnectionState } from "./socialConnectionState";
import { TikTokCreatorState, type TikTokGrantSnapshot } from "./tiktokCreatorState";
import { TikTokClient, TikTokError, TIKTOK_SCOPES, type TikTokConfig, type TikTokCreator } from "../providers/tiktok";
import { fail, privateJson, readBody, securityResponse } from "../security/errors";
import { oauthBrowserFailure } from "./oauthBrowserResponse";
export type TikTokConnectionRenewal = (request: { authorizationId: string; providerUserId: string; credentialVersion: number;
  mode: "mock" | "live"; verifyCurrent(): Promise<void> }) => Promise<void>;
export class TikTokConnectionService {
  readonly oauth: OAuthRequest;
  constructor(private readonly auth: CustomerAuth, private readonly connections: CustomerConnections,
    private readonly state: ProviderConnectionState, private readonly social: SocialConnectionState, private readonly creators: TikTokCreatorState,
    private readonly config: TikTokConfig, readonly mode: "mock" | "live", private readonly now = () => new Date(), private readonly renew?: TikTokConnectionRenewal) {
    const client = new TikTokClient(config);
    if (client.mode !== mode || client.redirectUri !== `${auth.origin}/api/connections/tiktok/callback`)
      fail("INVALID_CONFIG", 503, "Configure the registered TikTok callback and explicit provider mode.");
    this.oauth = { provider: "TIKTOK", capability: "SOCIAL", pkce: false, scopes: [...TIKTOK_SCOPES], redirectUri: client.redirectUri };
  }
  private client(verifyCurrent: () => Promise<void>) {
    return new TikTokClient({ ...this.config, beforeRequest: async () => { await verifyCurrent(); await this.config.beforeRequest?.(); await verifyCurrent(); } });
  }
  async start(principal: CustomerPrincipal, authorizationId?: string) {
    if (authorizationId) {
      const previous = await this.state.grant(principal, authorizationId, "TIKTOK", "SOCIAL", true);
      if (previous.connectionMode !== this.mode.toUpperCase()) fail("CONNECTION_MODE_MISMATCH", 409, "Create a new connection when changing provider modes.");
    }
    const attempt = await this.connections.beginOAuth(principal, { ...this.oauth, reconnectAuthorizationId: authorizationId });
    return { authorizationUrl: new TikTokClient(this.config).authorizationUrl({ state: attempt.state }), mode: this.mode };
  }
  private destinations(creator: TikTokCreator) {
    return [{ kind: "TIKTOK_PROFILE" as const, externalId: creator.openId, name: creator.nickname, available: true, canRead: true, canWrite: "ALLOWED" as const }];
  }
  async complete(principal: CustomerPrincipal, state: string, code?: string, denied = false, failed = false) {
    // Losing callbacks cannot consume or cancel a winner's exchange claim.
    const attempt = await this.connections.claimOAuthExchange(principal, state, this.oauth);
    try {
      if (failed) fail("PROVIDER_AUTHORIZATION_FAILED", 502, "TikTok could not authorize this connection. Start again.");
      if (denied) fail("CONSENT_DENIED", 400, "TikTok permission was declined.");
      if (!code || code.length > 4096) fail("INVALID_OAUTH_CODE", 400, "Restart the TikTok connection.");
      const previous = attempt.reconnectAuthorizationId ? await this.state.grant(principal, attempt.reconnectAuthorizationId, "TIKTOK", "SOCIAL", true) : undefined;
      if (previous && previous.connectionMode !== this.mode.toUpperCase()) fail("CONNECTION_MODE_MISMATCH", 409, "Create a new connection when changing provider modes.");
      const client = this.client(() => this.creators.verifyExchange(principal, state, attempt.exchangeClaimToken, this.oauth.redirectUri));
      const grant = await client.exchangeCode({ code, ...(previous ? { previous: { providerUserId: previous.providerUserId } } : {}) });
      const creator = await client.creatorInfo(grant.accessToken, grant.providerUserId);
      const connection = await this.connections.completeAuthorization(principal, state, this.oauth,
        { ...grant, connectionMode: this.mode === "mock" ? "MOCK" : "LIVE" }, attempt.exchangeClaimToken);
      const snapshot = await this.creators.snapshot(principal, connection.id, connection.credentialVersion, this.mode);
      await this.social.synchronize(principal, connection.id, "TIKTOK", connection.credentialVersion, this.destinations(creator));
      await this.creators.persist(principal, snapshot, creator);
      return { connection: await this.connections.get(principal, connection.id), mode: this.mode };
    } catch (error) { await this.state.cancelOAuth(principal, state, this.oauth, attempt.exchangeClaimToken); throw error; }
  }
  private async credentials(principal: CustomerPrincipal, id: string) {
    let current = await this.state.grant(principal, id, "TIKTOK", "SOCIAL");
    if (current.connectionMode !== this.mode.toUpperCase()) fail("CONNECTION_MODE_MISMATCH", 409, "This connection belongs to another provider mode.");
    let snapshot = await this.creators.snapshot(principal, id, current.credentialVersion, this.mode);
    if (current.expiresAt && current.expiresAt.getTime() <= this.now().getTime() + 60000) {
      if (!this.renew) fail("RECONNECT_REQUIRED", 409, "Reconnect TikTok before refreshing expired access.");
      await this.renew({ authorizationId: id, providerUserId: current.providerUserId, credentialVersion: current.credentialVersion,
        mode: this.mode, verifyCurrent: () => this.creators.verifyCurrent(principal, snapshot) });
      current = await this.state.grant(principal, id, "TIKTOK", "SOCIAL");
      if (current.connectionMode !== this.mode.toUpperCase() || !current.expiresAt || current.expiresAt.getTime() <= this.now().getTime() + 60000)
        fail("RECONNECT_REQUIRED", 409, "Renew TikTok access before continuing.");
      snapshot = await this.creators.snapshot(principal, id, current.credentialVersion, this.mode);
    }
    return { current, snapshot };
  }
  async refresh(principal: CustomerPrincipal, id: string, destinationId?: string, select = false) {
    const { current, snapshot } = await this.credentials(principal, id);
    const connection = await this.connections.get(principal, id);
    const destination = destinationId ? connection.destinations.find((row) => row.id === destinationId && row.kind === "TIKTOK_PROFILE") : undefined;
    if (destinationId && !destination) fail("NOT_FOUND", 404, "Choose a TikTok destination from this connection.");
    let creator: TikTokCreator;
    try { creator = await this.client(() => this.creators.verifyCurrent(principal, snapshot)).creatorInfo(current.accessToken!, current.providerUserId); }
    catch (error) {
      if (error instanceof TikTokError && ["RECONNECT_REQUIRED", "MISSING_PERMISSION", "PROVIDER_IDENTITY_MISMATCH"].includes(error.code))
        await this.state.requireReconnect(principal, id, current.credentialVersion);
      throw error;
    }
    await this.social.synchronize(principal, id, "TIKTOK", current.credentialVersion, this.destinations(creator));
    await this.creators.persist(principal, snapshot, creator);
    if (destination && destination.externalId !== creator.openId) fail("PROVIDER_IDENTITY_MISMATCH", 409, "Choose the original verified TikTok creator.");
    if (select && destination) await this.social.select(principal, id, "TIKTOK", current.credentialVersion, destination.id, this.mode);
    return { connection: await this.connections.get(principal, id), mode: this.mode };
  }
}
export function createTikTokConnectionApi(auth: CustomerAuth, service: TikTokConnectionService) {
  return async (request: Request) => {
    const url = new URL(request.url), callback = url.pathname === "/api/connections/tiktok/callback";
    const html = callback && request.method === "GET" && request.headers.get("accept")?.includes("text/html");
    try {
      const principal = await auth.requireSession(request);
      if (callback && request.method === "GET") {
        if (["state", "code", "error"].some((key) => url.searchParams.getAll(key).length > 1)) fail("INVALID_OAUTH_STATE", 400, "Restart the TikTok connection.");
        const result = await service.complete(principal, url.searchParams.get("state") ?? "", url.searchParams.get("code") ?? undefined,
          url.searchParams.get("error") === "access_denied", url.searchParams.has("error") && url.searchParams.get("error") !== "access_denied");
        if (html) return new Response(null, { status: 303, headers: { Location: `${auth.origin}/connections?provider=tiktok&result=connected`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
        return privateJson(result);
      }
      auth.assertOrigin(request); if (request.method !== "POST") fail("METHOD_NOT_ALLOWED", 405, "Use POST for connection actions.");
      const body = await readBody(request);
      if (url.pathname === "/api/connections/tiktok/start") {
        if (Object.keys(body).some((key) => key !== "authorizationId") || (body.authorizationId !== undefined && (typeof body.authorizationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.authorizationId))))
          fail("INVALID_BODY", 400, "Supply only an optional owned connection to reconnect.");
        return privateJson(await service.start(principal, body.authorizationId as string | undefined));
      }
      const match = url.pathname.match(/^\/api\/connections\/tiktok\/([A-Za-z0-9_-]{1,128})\/(refresh|check|select)$/);
      if (!match) fail("NOT_FOUND", 404, "TikTok action not found.");
      if (match[2] === "refresh") {
        if (Object.keys(body).length) fail("INVALID_BODY", 400, "Discovery does not accept credentials or creator settings.");
        return privateJson(await service.refresh(principal, match[1]));
      }
      if (Object.keys(body).some((key) => key !== "destinationId") || typeof body.destinationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.destinationId))
        fail("INVALID_BODY", 400, "Supply only an owned destination ID.");
      return privateJson(await service.refresh(principal, match[1], body.destinationId, match[2] === "select"));
    } catch (error) { return html ? oauthBrowserFailure(auth.origin, "tiktok", error) : securityResponse(error); }
  };
}
