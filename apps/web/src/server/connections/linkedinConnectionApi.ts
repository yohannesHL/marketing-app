import { CustomerAuth, type CustomerPrincipal } from "../auth/customerAuth";
import { CustomerConnections, type OAuthRequest } from "./customerConnections";
import { ProviderConnectionState } from "./providerConnectionState";
import { SocialConnectionState, type DiscoveredSocialDestination } from "./socialConnectionState";
import { LinkedInConnectionState } from "./linkedinConnectionState";
import { LinkedInClient, LinkedInError, LINKEDIN_ORGANIZATION_SCOPES, linkedInPersonUrn, type LinkedInConfig } from "../providers/linkedin";
import { fail, privateJson, readBody, securityResponse } from "../security/errors";
import { oauthBrowserFailure } from "./oauthBrowserResponse";
export type LinkedInConnectionRenewal = (request: {
  authorizationId: string; providerUserId: string; credentialVersion: number; mode: "mock" | "live"; verifyCurrent(): Promise<void>;
}) => Promise<void>;
export class LinkedInConnectionService {
  readonly oauth: OAuthRequest;
  constructor(private readonly auth: CustomerAuth, private readonly connections: CustomerConnections,
    private readonly state: ProviderConnectionState, private readonly social: SocialConnectionState, private readonly fences: LinkedInConnectionState,
    private readonly config: LinkedInConfig, readonly mode: "mock" | "live", private readonly now = () => new Date(), private readonly renew?: LinkedInConnectionRenewal) {
    const client = new LinkedInClient(config), configMode = config.mockoonEnabled === true && config.mockoonBaseUrl ? "mock" : "live";
    if (mode !== configMode || client.redirectUri !== `${auth.origin}/api/connections/linkedin/callback`)
      fail("INVALID_CONFIG", 503, "Configure the registered LinkedIn callback and explicit provider mode.");
    this.config = { ...config, scopes: [...client.scopes] };
    this.oauth = { provider: "LINKEDIN", capability: "SOCIAL", redirectUri: client.redirectUri, scopes: [...client.scopes], pkce: false };
  }
  private client(verifyCurrent: () => Promise<void>) {
    return new LinkedInClient({ ...this.config, beforeRequest: async () => { await verifyCurrent(); await this.config.beforeRequest?.(); await verifyCurrent(); } });
  }
  async start(principal: CustomerPrincipal, authorizationId?: string) {
    if (authorizationId) {
      const previous = await this.state.grant(principal, authorizationId, "LINKEDIN", "SOCIAL", true);
      if (previous.connectionMode !== this.mode.toUpperCase()) fail("CONNECTION_MODE_MISMATCH", 409, "Reconnect LinkedIn in its original mode.");
    }
    const attempt = await this.connections.beginOAuth(principal, { ...this.oauth, reconnectAuthorizationId: authorizationId });
    return { authorizationUrl: new LinkedInClient(this.config).authorizationUrl({ state: attempt.state }), mode: this.mode };
  }
  private scopeFailure(authorUrn: string, actual: readonly string[]) {
    const organization = authorUrn.startsWith("urn:li:organization:"), write = organization ? "w_organization_social" : "w_member_social",
      read = organization ? "r_organization_social" : "r_member_social";
    if (!this.config.scopes.includes(write) || !actual.includes(write) || (organization && (!this.config.scopes.includes("rw_organization_admin") || !actual.includes("rw_organization_admin"))))
      return "MISSING_PERMISSION";
    if (!this.config.scopes.includes(read) || !actual.includes(read)) return "READ_CAPABILITY_REQUIRED";
    return undefined;
  }
  private async discover(client: LinkedInClient, token: string, subject: string) {
    const identity = await client.verifiedIdentity(token);
    if (identity.providerUserId !== subject) fail("PROVIDER_IDENTITY_MISMATCH", 409, "Reconnect the original LinkedIn identity.");
    const actual = await client.inspectToken(token), memberFailure = this.scopeFailure(identity.personUrn, actual.scopes);
    if (!memberFailure) await client.verifyAuthor(token, { providerUserId: subject, authorUrn: identity.personUrn });
    const rows: DiscoveredSocialDestination[] = [{ kind: "LINKEDIN_MEMBER", externalId: identity.personUrn, name: identity.name,
      available: !memberFailure, canRead: !memberFailure, canWrite: memberFailure ? "DENIED" : "ALLOWED", ...(memberFailure ? { tasks: [memberFailure] } : {}) }];
    if (LINKEDIN_ORGANIZATION_SCOPES.every(scope => this.config.scopes.includes(scope) && actual.scopes.includes(scope))) {
      for (const organization of await client.discoverOrganizations(token, { providerUserId: subject }))
        rows.push({ kind: "LINKEDIN_ORGANIZATION", externalId: organization.authorUrn, name: `LinkedIn organization ${organization.authorUrn.split(":").at(-1)}`,
          available: true, canRead: true, canWrite: "ALLOWED" });
    }
    return rows;
  }
  async complete(principal: CustomerPrincipal, stateValue: string, code?: string, denied = false, failed = false) {
    const attempt = await this.connections.claimOAuthExchange(principal, stateValue, this.oauth);
    try {
      if (attempt.requestedScopes.length !== this.oauth.scopes.length || !attempt.requestedScopes.every(scope => this.oauth.scopes.includes(scope)))
        fail("INVALID_OAUTH_STATE", 400, "LinkedIn permissions changed after this attempt began. Start again.");
      if (denied) fail("CONSENT_DENIED", 400, "LinkedIn permission was declined.");
      if (failed) fail("PROVIDER_AUTHORIZATION_FAILED", 502, "LinkedIn could not authorize this connection. Start again.");
      if (!code || code.length > 4096) fail("INVALID_OAUTH_CODE", 400, "Restart the LinkedIn connection.");
      const previous = attempt.reconnectAuthorizationId ? await this.state.grant(principal, attempt.reconnectAuthorizationId, "LINKEDIN", "SOCIAL", true) : undefined;
      if (previous && previous.connectionMode !== this.mode.toUpperCase()) fail("CONNECTION_MODE_MISMATCH", 409, "Create a new connection when changing provider mode.");
      const client = this.client(() => this.fences.verifyExchange(principal, stateValue, attempt.exchangeClaimToken, this.oauth.redirectUri)), grant = await client.exchangeCode({ code });
      if (previous && grant.providerUserId !== previous.providerUserId) fail("PROVIDER_IDENTITY_MISMATCH", 409, "Reconnect the original LinkedIn identity.");
      const destinations = await this.discover(client, grant.accessToken, grant.providerUserId);
      const connection = await this.connections.completeAuthorization(principal, stateValue, this.oauth,
        { ...grant, connectionMode: this.mode.toUpperCase() as "MOCK" | "LIVE" }, attempt.exchangeClaimToken);
      const snapshot = await this.fences.snapshot(principal, connection.id, connection.credentialVersion, this.mode);
      await this.fences.verifyCurrent(principal, snapshot);
      await this.social.synchronize(principal, connection.id, "LINKEDIN", connection.credentialVersion, destinations);
      return { connection: await this.connections.get(principal, connection.id), mode: this.mode };
    } catch (error) { await this.state.cancelOAuth(principal, stateValue, this.oauth, attempt.exchangeClaimToken).catch(() => {}); throw error; }
  }
  private async credentials(principal: CustomerPrincipal, id: string) {
    let grant = await this.state.grant(principal, id, "LINKEDIN", "SOCIAL");
    if (grant.connectionMode !== this.mode.toUpperCase()) fail("CONNECTION_MODE_MISMATCH", 409, "Choose a LinkedIn connection for this mode.");
    let snapshot = await this.fences.snapshot(principal, id, grant.credentialVersion, this.mode);
    if (!grant.expiresAt || grant.expiresAt.getTime() <= this.now().getTime() + 60000) {
      if (!this.renew || this.config.mdpRefreshEnabled !== true || !grant.refreshToken || !snapshot.refreshExpiresAt || snapshot.refreshExpiresAt <= this.now())
        fail("RECONNECT_REQUIRED", 409, "Reconnect LinkedIn unless this app has an actual approved, unexpired MDP refresh grant.");
      await this.renew({ authorizationId: id, providerUserId: grant.providerUserId, credentialVersion: grant.credentialVersion, mode: this.mode,
        verifyCurrent: () => this.fences.verifyCurrent(principal, snapshot, true) });
      grant = await this.state.grant(principal, id, "LINKEDIN", "SOCIAL");
      if (grant.connectionMode !== this.mode.toUpperCase()) fail("CONNECTION_MODE_MISMATCH", 409, "The LinkedIn mode changed during renewal.");
      const current = await this.fences.snapshot(principal, id, grant.credentialVersion, this.mode);
      if (current.generation !== snapshot.generation || current.providerUserId !== snapshot.providerUserId) fail("STALE_CREDENTIALS", 409, "LinkedIn changed during renewal.");
      snapshot = current;
    }
    await this.fences.verifyCurrent(principal, snapshot);
    return { grant, snapshot };
  }
  async refresh(principal: CustomerPrincipal, id: string, destinationId?: string, select = false) {
    const { grant, snapshot } = await this.credentials(principal, id), connection = await this.connections.get(principal, id);
    const target = destinationId ? connection.destinations.find(d => d.id === destinationId && ["LINKEDIN_MEMBER", "LINKEDIN_ORGANIZATION"].includes(d.kind)) : undefined;
    if (destinationId && !target) fail("NOT_FOUND", 404, "Choose a LinkedIn author belonging to this connection.");
    if (target?.kind === "LINKEDIN_MEMBER" && target.externalId !== linkedInPersonUrn(grant.providerUserId)) fail("AUTHOR_MISMATCH", 403, "Choose the verified LinkedIn member.");
    const client = this.client(() => this.fences.verifyCurrent(principal, snapshot));
    try {
      if (target) {
        const missing = this.scopeFailure(target.externalId, grant.scopes);
        if (missing) {
          await this.fences.invalidateAuthor(principal, snapshot, target.id);
          fail(missing, 403, "Approved LinkedIn read and publishing permissions are required for this author.");
        }
        await client.verifyAuthor(grant.accessToken!, { providerUserId: grant.providerUserId, authorUrn: target.externalId });
      }
      const rows = await this.discover(client, grant.accessToken!, grant.providerUserId);
      await this.fences.verifyCurrent(principal, snapshot);
      await this.social.synchronize(principal, id, "LINKEDIN", grant.credentialVersion, rows);
      if (target) {
        const missing = this.scopeFailure(target.externalId, grant.scopes);
        if (missing) fail(missing, 403, "Approved LinkedIn read and publishing permissions are required for this author.");
        await client.verifyAuthor(grant.accessToken!, { providerUserId: grant.providerUserId, authorUrn: target.externalId });
        if (!rows.some(d => d.kind === target.kind && d.externalId === target.externalId && d.available))
          fail("ORGANIZATION_ROLE_REQUIRED", 403, "Restore approved organic publishing access to this LinkedIn author.");
        if (select) {
          await this.fences.verifyCurrent(principal, snapshot);
          await this.social.select(principal, id, "LINKEDIN", grant.credentialVersion, target.id, this.mode);
        }
      }
      return { connection: await this.connections.get(principal, id), mode: this.mode };
    } catch (error) {
      if (target && error instanceof LinkedInError && ["ORGANIZATION_ROLE_REQUIRED", "READ_CAPABILITY_REQUIRED", "MISSING_PERMISSION", "AUTHOR_MISMATCH"].includes(error.code))
        await this.fences.invalidateAuthor(principal, snapshot, target.id);
      if (error instanceof LinkedInError && ["RECONNECT_REQUIRED", "MISSING_PERMISSION", "PROVIDER_IDENTITY_MISMATCH"].includes(error.code))
        await this.state.requireReconnect(principal, id, grant.credentialVersion);
      throw error;
    }
  }
}
export function createLinkedInConnectionApi(auth: CustomerAuth, service: LinkedInConnectionService) {
  return async (request: Request) => {
    const url = new URL(request.url), callback = url.pathname === "/api/connections/linkedin/callback",
      html = callback && request.method === "GET" && request.headers.get("accept")?.includes("text/html");
    try {
      const principal = await auth.requireSession(request);
      if (callback && request.method === "GET") {
        if (["state", "code", "error"].some(key => url.searchParams.getAll(key).length > 1)) fail("INVALID_OAUTH_STATE", 400, "Restart the LinkedIn connection.");
        const error = url.searchParams.get("error"), denied = ["access_denied", "user_cancelled_login", "user_cancelled_authorize"].includes(error ?? "");
        const result = await service.complete(principal, url.searchParams.get("state") ?? "", url.searchParams.get("code") ?? undefined, denied, !!error && !denied);
        return html ? new Response(null, { status: 303, headers: { Location: `${auth.origin}/connections?provider=linkedin&result=connected`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } }) : privateJson(result);
      }
      auth.assertOrigin(request); if (request.method !== "POST") fail("METHOD_NOT_ALLOWED", 405, "Use POST for connection actions.");
      const body = await readBody(request);
      if (url.pathname === "/api/connections/linkedin/start") {
        if (Object.keys(body).some(key => key !== "authorizationId") || (body.authorizationId !== undefined && (typeof body.authorizationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.authorizationId))))
          fail("INVALID_BODY", 400, "Supply only an optional owned connection to reconnect.");
        return privateJson(await service.start(principal, body.authorizationId as string | undefined));
      }
      const match = url.pathname.match(/^\/api\/connections\/linkedin\/([A-Za-z0-9_-]{1,128})\/(refresh|check|select)$/);
      if (!match) fail("NOT_FOUND", 404, "LinkedIn action not found.");
      if (match[2] === "refresh") {
        if (Object.keys(body).length) fail("INVALID_BODY", 400, "Discovery does not accept scopes, credentials or publishing authors.");
        return privateJson(await service.refresh(principal, match[1]));
      }
      if (Object.keys(body).some(key => key !== "destinationId") || typeof body.destinationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.destinationId))
        fail("INVALID_BODY", 400, "Supply only an owned destination ID.");
      return privateJson(await service.refresh(principal, match[1], body.destinationId, match[2] === "select"));
    } catch (error) { return html ? oauthBrowserFailure(auth.origin, "linkedin", error) : securityResponse(error); }
  };
}
