import { CustomerAuth, type CustomerPrincipal } from "../auth/customerAuth";
import { CustomerConnections, type OAuthRequest } from "./customerConnections";
import { ProviderConnectionState } from "./providerConnectionState";
import { SocialConnectionState } from "./socialConnectionState";
import { YouTubeClient, YouTubeError, YOUTUBE_SCOPES, type YouTubeChannel } from "../providers/youtube";
import { fail, privateJson, readBody, securityResponse } from "../security/errors";
import { oauthBrowserFailure } from "./oauthBrowserResponse";

export class YouTubeConnectionService {
  readonly oauth: OAuthRequest;
  constructor(private readonly auth: CustomerAuth, private readonly connections: CustomerConnections,
    private readonly state: ProviderConnectionState, private readonly social: SocialConnectionState,
    private readonly client: YouTubeClient, readonly mode: "mock" | "live", private readonly now = () => new Date()) {
    this.oauth = { provider: "GOOGLE", capability: "SOCIAL", pkce: true, scopes: [...YOUTUBE_SCOPES],
      redirectUri: `${auth.origin}/api/connections/youtube/callback` };
  }
  async start(principal: CustomerPrincipal, authorizationId?: string) {
    const attempt = await this.connections.beginOAuth(principal, { ...this.oauth, reconnectAuthorizationId: authorizationId });
    return { authorizationUrl: this.client.authorizationUrl({ state: attempt.state, codeChallenge: attempt.codeChallenge! }), mode: this.mode };
  }
  private destinations(channels: YouTubeChannel[]) {
    // Ordinary upload consent identifies a single channel; local selection cannot retarget a token.
    return channels.map((channel) => ({ kind: "YOUTUBE_CHANNEL" as const, externalId: channel.id, name: channel.title,
      available: channels.length === 1, canRead: true, canWrite: channels.length === 1 ? "ALLOWED" as const : "DENIED" as const }));
  }
  async complete(principal: CustomerPrincipal, state: string, code?: string, denied = false, failed = false) {
    const attempt = await this.connections.claimOAuthExchange(principal, state, this.oauth);
    try {
      if (failed) fail("PROVIDER_AUTHORIZATION_FAILED", 502, "YouTube could not authorize this connection. Start again.");
      if (denied) fail("CONSENT_DENIED", 400, "YouTube permission was declined.");
      if (!code || code.length > 4096 || !attempt.codeVerifier) fail("INVALID_OAUTH_CODE", 400, "Restart the YouTube connection.");
      const previous = attempt.reconnectAuthorizationId ? await this.state.grant(principal, attempt.reconnectAuthorizationId, "GOOGLE", "SOCIAL", true) : undefined;
      if (previous && previous.connectionMode !== this.mode.toUpperCase()) fail("CONNECTION_MODE_MISMATCH", 409, "Create a new connection when changing provider modes.");
      const grant = await this.client.exchangeCode({ code, codeVerifier: attempt.codeVerifier,
        ...(previous?.refreshToken ? { previous: { providerUserId: previous.providerUserId, refreshToken: previous.refreshToken } } : {}) });
      if (previous && grant.providerUserId !== previous.providerUserId) fail("PROVIDER_IDENTITY_MISMATCH", 409, "Reconnect the original Google identity.");
      const channels = await this.client.discoverChannels(grant.accessToken);
      const connection = await this.connections.completeAuthorization(principal, state, this.oauth,
        { ...grant, connectionMode: this.mode === "mock" ? "MOCK" : "LIVE" }, attempt.exchangeClaimToken);
      await this.social.synchronize(principal, connection.id, "GOOGLE", connection.credentialVersion, this.destinations(channels));
      return { connection: await this.connections.get(principal, connection.id), mode: this.mode };
    } catch (error) { await this.state.cancelOAuth(principal, state, this.oauth, attempt.exchangeClaimToken); throw error; }
  }
  private async credentials(principal: CustomerPrincipal, id: string) {
    let current = await this.state.grant(principal, id, "GOOGLE", "SOCIAL");
    if (current.connectionMode !== this.mode.toUpperCase()) fail("CONNECTION_MODE_MISMATCH", 409, "This connection belongs to another provider mode.");
    if (current.expiresAt && current.expiresAt.getTime() <= this.now().getTime() + 60_000) {
      try {
        const renewed = await this.client.renewVerified({ providerUserId: current.providerUserId, refreshToken: current.refreshToken ?? "", scopes: current.scopes });
        await this.connections.updateCredentials(id, current.credentialVersion, renewed);
      } catch (error) {
        if (error instanceof YouTubeError && ["RECONNECT_REQUIRED", "MISSING_PERMISSION", "PROVIDER_IDENTITY_MISMATCH"].includes(error.code))
          await this.state.requireReconnect(principal, id, current.credentialVersion);
        throw error;
      }
      current = await this.state.grant(principal, id, "GOOGLE", "SOCIAL");
    }
    return current;
  }
  async refresh(principal: CustomerPrincipal, id: string, destinationId?: string, select = false) {
    const grant = await this.credentials(principal, id);
    const channels = await this.client.discoverChannels(grant.accessToken!);
    const connection = await this.connections.get(principal, id);
    const destination = destinationId ? connection.destinations.find((item) => item.id === destinationId && item.kind === "YOUTUBE_CHANNEL") : undefined;
    if (destinationId && !destination) fail("NOT_FOUND", 404, "Choose a YouTube destination from this connection.");
    await this.social.synchronize(principal, id, "GOOGLE", grant.credentialVersion, this.destinations(channels));
    if (destination && (channels.length !== 1 || channels[0].id !== destination.externalId))
      fail("CHANNEL_MISMATCH", 409, "Reconnect and choose the intended YouTube channel or Brand Account during consent.");
    if (select && destination) await this.social.select(principal, id, "GOOGLE", grant.credentialVersion, destination.id, this.mode);
    return { connection: await this.connections.get(principal, id), mode: this.mode };
  }
}

export function createYouTubeConnectionApi(auth: CustomerAuth, service: YouTubeConnectionService) {
  return async (request: Request) => {
    const url = new URL(request.url), callback = url.pathname === "/api/connections/youtube/callback";
    const html = callback && request.method === "GET" && request.headers.get("accept")?.includes("text/html");
    try {
      const principal = await auth.requireSession(request);
      if (callback && request.method === "GET") {
        const result = await service.complete(principal, url.searchParams.get("state") ?? "", url.searchParams.get("code") ?? undefined,
          url.searchParams.get("error") === "access_denied", url.searchParams.has("error") && url.searchParams.get("error") !== "access_denied");
        if (html) return new Response(null, { status: 303, headers: { Location: `${auth.origin}/connections?provider=youtube&result=connected`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
        return privateJson(result);
      }
      auth.assertOrigin(request);
      if (request.method !== "POST") fail("METHOD_NOT_ALLOWED", 405, "Use POST for connection actions.");
      const body = await readBody(request);
      if (url.pathname === "/api/connections/youtube/start") {
        if (Object.keys(body).some((key) => key !== "authorizationId") || (body.authorizationId !== undefined && typeof body.authorizationId !== "string"))
          fail("INVALID_BODY", 400, "Supply only an optional connection to reconnect.");
        return privateJson(await service.start(principal, body.authorizationId as string | undefined));
      }
      const match = url.pathname.match(/^\/api\/connections\/youtube\/([A-Za-z0-9_-]{1,128})\/(refresh|check|select)$/);
      if (!match) fail("NOT_FOUND", 404, "YouTube action not found.");
      if (match[2] === "refresh") {
        if (Object.keys(body).length) fail("INVALID_BODY", 400, "Discovery does not accept credentials or provider IDs.");
        return privateJson(await service.refresh(principal, match[1]));
      }
      if (Object.keys(body).some((key) => key !== "destinationId") || typeof body.destinationId !== "string")
        fail("INVALID_BODY", 400, "Supply an owned destination ID.");
      return privateJson(await service.refresh(principal, match[1], body.destinationId, match[2] === "select"));
    } catch (error) { return html ? oauthBrowserFailure(auth.origin, "youtube", error) : securityResponse(error); }
  };
}
