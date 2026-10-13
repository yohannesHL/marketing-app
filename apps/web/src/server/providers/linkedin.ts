import { SecurityError } from "../security/errors";
import { mockoonOrigin } from "./providerHttp";
export const LINKEDIN_VERSION = "202609";
export const LINKEDIN_MEMBER_SCOPES = ["openid", "profile", "w_member_social"] as const;
export const LINKEDIN_ORGANIZATION_SCOPES = ["openid", "profile", "w_organization_social", "rw_organization_admin", "r_organization_social"] as const;
const allowedScopes = new Set([...LINKEDIN_MEMBER_SCOPES, ...LINKEDIN_ORGANIZATION_SCOPES, "r_member_social"]);
export type LinkedInConfig = { clientId: string; clientSecret: string; redirectUri: string; scopes: readonly string[];
  version?: typeof LINKEDIN_VERSION; mdpRefreshEnabled?: boolean; mockoonEnabled?: boolean; mockoonBaseUrl?: string;
  requestTimeoutMs?: number; now?: () => Date; beforeRequest?: () => Promise<void> };
export type LinkedInGrant = { providerUserId: string; personUrn: string; accessToken: string; scopes: string[]; expiresAt: Date;
  refreshToken?: string; refreshExpiresAt?: Date };
export type LinkedInActor = { providerUserId: string; authorUrn: string };
export type LinkedInImagePlan = { type: "IMAGE"; ownerUrn: string; mediaUrn: string; uploadUrl: string; expiresAt: number };
export type LinkedInVideoPlan = { type: "VIDEO"; ownerUrn: string; mediaUrn: string; expiresAt: number; totalBytes: number;
  uploadToken: string; parts: { uploadUrl: string; firstByte: number; lastByte: number }[] };
export type LinkedInMediaStatus = { mediaUrn: string; ownerUrn: string; status: "AVAILABLE" | "PROCESSING" | "PROCESSING_FAILED" | "WAITING_UPLOAD" };
export type LinkedInPostInput = { commentary: string; visibility: "PUBLIC" | "CONNECTIONS"; mediaUrn?: string; title?: string };
export type LinkedInPostStatus = { postUrn: string; authorUrn: string; visibility: "PUBLIC" | "CONNECTIONS";
  mediaUrn?: string; lifecycleState: string; state: "PUBLISHED" | "PENDING" | "FAILED" | "DRAFT" };
export function linkedInPlainText(value: string) { return value.replace(/[|{}@\[\]()<>#\\*_~]/g, "\\$&"); }
export class LinkedInError extends SecurityError {
  constructor(code: string, status = 502, readonly retryable = false, readonly outcomeUnknown = false) {
    super(code, status, ({ RECONNECT_REQUIRED: "Reconnect LinkedIn to restore access.", MISSING_PERMISSION: "Restore the approved LinkedIn permissions required by this operation.",
      AUTHOR_MISMATCH: "Choose the verified LinkedIn publishing author.", ORGANIZATION_ROLE_REQUIRED: "Restore approved organic posting access to this organization.",
      READ_CAPABILITY_REQUIRED: "Approved LinkedIn read access is required to confirm this delivery.", MEDIA_EXPIRED: "The private media upload expired. Reconcile its saved asset before retrying.",
      PROVIDER_OUTCOME_UNKNOWN: "The provider outcome needs checking before retrying.", PROVIDER_RATE_LIMITED: "LinkedIn limits were reached. Try again later.",
    } as Record<string, string>)[code] ?? "The LinkedIn request could not be completed."); this.name = "LinkedInError";
  }
}
type Json = Record<string, unknown>;
const fail = (code = "INVALID_PROVIDER_RESPONSE", status = 502): never => { throw new LinkedInError(code, status); };
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : fail();
const text = (value: unknown, max = 32768): string => typeof value === "string" && value.length > 0 && value.length <= max ? value : fail();
function seconds(value: unknown) { if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return fail(); return value; }
export function linkedInPersonUrn(subject: string) { if (!/^[A-Za-z0-9_-]{1,255}$/.test(subject)) return fail("AUTHOR_MISMATCH", 403); return `urn:li:person:${subject}`; }
export function linkedInAuthorUrn(value: string) { if (!/^urn:li:(?:person:[A-Za-z0-9_-]{1,255}|organization:\d{1,25})$/.test(value)) return fail("AUTHOR_MISMATCH", 403); return value; }
function scopeList(value: unknown) { return [...new Set(text(value, 8192).split(/[\s,]+/).filter(Boolean))]; }
export class LinkedInClient {
  readonly scopes: string[];
  readonly pkce = false;
  readonly redirectUri: string;
  private readonly origin?: string;
  private readonly now: () => Date;
  private readonly timeout: number;
  constructor(private readonly config: LinkedInConfig) {
    if (!config.clientId || config.clientId.length > 512 || !config.clientSecret || config.clientSecret.length > 32768 ||
      !Array.isArray(config.scopes) || new Set(config.scopes).size !== config.scopes.length ||
      config.scopes.some((scope) => !allowedScopes.has(scope)) || !["openid", "profile"].every((scope) => config.scopes.includes(scope)) ||
      !config.scopes.some((scope) => ["w_member_social", "w_organization_social"].includes(scope)) ||
      (config.version !== undefined && config.version !== LINKEDIN_VERSION) || (config.mockoonBaseUrl && config.mockoonEnabled !== true)) throw new LinkedInError("INVALID_CONFIG", 503);
    this.origin = mockoonOrigin(config.mockoonBaseUrl);
    let callback: URL; try { callback = new URL(config.redirectUri); } catch { throw new LinkedInError("INVALID_CONFIG", 503); }
    if (callback.username || callback.password || callback.search || callback.hash ||
      !(callback.protocol === "https:" || (this.origin && callback.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname)))) throw new LinkedInError("INVALID_CONFIG", 503);
    this.redirectUri = callback.href; this.scopes = [...config.scopes]; this.now = config.now ?? (() => new Date());
    this.timeout = config.requestTimeoutMs ?? 20_000;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 1 || this.timeout > 60_000) throw new LinkedInError("INVALID_CONFIG", 503);
  }
  authorizationUrl(input: { state: string }) {
    if (!input.state || input.state.length > 1024) return fail("INVALID_OAUTH_STATE", 400);
    const url = new URL("/oauth/v2/authorization", this.origin ?? "https://www.linkedin.com");
    url.search = new URLSearchParams({ response_type: "code", client_id: this.config.clientId, redirect_uri: this.redirectUri, state: input.state, scope: this.scopes.join(" ") }).toString();
    return url.href;
  }
  async exchangeCode(input: { code: string }): Promise<LinkedInGrant> {
    if (!input.code || input.code.length > 4096) return fail("INVALID_OAUTH_STATE", 400);
    const tokens = await this.form("accessToken", { grant_type: "authorization_code", code: input.code, redirect_uri: this.redirectUri });
    return this.grant(tokens);
  }
  async renewVerified(input: { providerUserId: string; refreshToken: string; refreshExpiresAt: Date; scopes: string[] }): Promise<LinkedInGrant> {
    if (this.config.mdpRefreshEnabled !== true || !input.refreshToken || !(input.refreshExpiresAt instanceof Date) || !Number.isFinite(input.refreshExpiresAt.getTime()) || input.refreshExpiresAt <= this.now()) return fail("RECONNECT_REQUIRED", 409);
    const tokens = await this.form("accessToken", { grant_type: "refresh_token", refresh_token: input.refreshToken });
    const grant = await this.grant(tokens);
    if (grant.providerUserId !== input.providerUserId) return fail("PROVIDER_IDENTITY_MISMATCH", 409);
    if (!grant.refreshToken || !grant.refreshExpiresAt) return fail("RECONNECT_REQUIRED", 409);
    grant.refreshExpiresAt = new Date(Math.min(grant.refreshExpiresAt.getTime(), input.refreshExpiresAt.getTime()));
    return grant;
  }
  async verifiedIdentity(accessToken: string) {
    const identity = await this.json(await this.request(this.url("/v2/userinfo"), { headers: this.bearer(accessToken) }));
    const providerUserId = text(identity.sub, 255); return { providerUserId, personUrn: linkedInPersonUrn(providerUserId), name: typeof identity.name === "string" ? identity.name.slice(0, 512) : "LinkedIn member" };
  }
  async inspectToken(accessToken: string) {
    const result = await this.form("introspectToken", { token: text(accessToken) });
    if (result.active !== true || (result.status !== undefined && result.status !== "active")) return fail("RECONNECT_REQUIRED", 409);
    if (result.client_id !== this.config.clientId || result.auth_type !== "3L") return fail("PROVIDER_IDENTITY_MISMATCH", 409);
    const scopes = scopeList(result.scope);
    let expiresAt: Date | undefined;
    if (result.expires_at !== undefined) { expiresAt = new Date(seconds(result.expires_at) * 1000); if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= this.now()) return fail("RECONNECT_REQUIRED", 409); }
    return { scopes, expiresAt };
  }
  async verifyAuthor(accessToken: string, input: { providerUserId: string; authorUrn: string; requireRead?: boolean; requireWrite?: boolean }) {
    const authorUrn = linkedInAuthorUrn(input.authorUrn);
    const identity = await this.verifiedIdentity(accessToken);
    if (identity.providerUserId !== input.providerUserId) return fail("PROVIDER_IDENTITY_MISMATCH", 409);
    const actual = await this.inspectToken(accessToken);
    const organization = authorUrn.startsWith("urn:li:organization:");
    const required = ["openid", "profile", ...(input.requireWrite !== false ? [organization ? "w_organization_social" : "w_member_social"] : [])];
    if (required.some((scope) => !actual.scopes.includes(scope))) return fail("MISSING_PERMISSION", 403);
    if (input.requireRead !== false && !actual.scopes.includes(organization ? "r_organization_social" : "r_member_social"))
      return fail("READ_CAPABILITY_REQUIRED", 403);
    if (!organization && authorUrn !== identity.personUrn) return fail("AUTHOR_MISMATCH", 403);
    if (organization) {
      if (!actual.scopes.includes("rw_organization_admin")) return fail("MISSING_PERMISSION", 403);
      if (input.requireWrite !== false) await this.organizationAction(accessToken, identity.personUrn, authorUrn, "ORGANIC_SHARE_CREATE");
      if (input.requireRead !== false) await this.organizationAction(accessToken, identity.personUrn, authorUrn, "ORGANIC_SHARE_VIEW_AS_AUTHOR");
    }
    return { ...identity, authorUrn, scopes: actual.scopes };
  }
  async discoverOrganizations(accessToken: string, input: { providerUserId: string }) {
    const identity = await this.verifiedIdentity(accessToken);
    if (identity.providerUserId !== input.providerUserId) return fail("PROVIDER_IDENTITY_MISMATCH", 409);
    const actual = await this.inspectToken(accessToken);
    if (LINKEDIN_ORGANIZATION_SCOPES.some((scope) => !actual.scopes.includes(scope))) return fail("MISSING_PERMISSION", 403);
    const organizations = new Map<string, { authorUrn: string; personUrn: string }>();
    let start = 0;
    for (let page = 0; page < 100; page++) {
      const url = new URL(this.url("/rest/organizationAcls"));
      url.search = new URLSearchParams({ q: "roleAssignee", state: "APPROVED", count: "100", start: String(start) }).toString();
      const result = await this.json(await this.request(url.href, { headers: this.headers(accessToken) }));
      if (!Array.isArray(result.elements)) return fail();
      for (const value of result.elements) {
        const row = object(value);
        if (row.roleAssignee !== identity.personUrn || row.state !== "APPROVED") continue;
        const authorUrn = linkedInAuthorUrn(text(row.organization ?? row.organizationTarget, 512));
        if (!authorUrn.startsWith("urn:li:organization:")) return fail();
        try { await this.verifyAuthor(accessToken, { ...input, authorUrn }); }
        catch (error) { if (error instanceof LinkedInError && error.code === "ORGANIZATION_ROLE_REQUIRED") continue; throw error; }
        organizations.set(authorUrn, { authorUrn, personUrn: identity.personUrn });
      }
      const paging = object(result.paging);
      if (paging.start !== start || (paging.links !== undefined && !Array.isArray(paging.links))) return fail();
      const next = (Array.isArray(paging.links) ? paging.links : []).map(object).filter((link) => link.rel === "next");
      if (!next.length) return [...organizations.values()];
      if (next.length !== 1) return fail();
      let link: URL; try { link = new URL(text(next[0].href, 8192), url); } catch { return fail(); }
      const newStart = Number(link.searchParams.get("start"));
      if (link.origin !== url.origin || link.pathname !== url.pathname || link.username || link.password || link.hash ||
        link.searchParams.get("q") !== "roleAssignee" || link.searchParams.get("state") !== "APPROVED" ||
        link.searchParams.get("count") !== "100" || !Number.isSafeInteger(newStart) || newStart <= start || newStart > 1_000_000) return fail();
      start = newStart;
    }
    return fail();
  }
  async initializeImage(accessToken: string, actor: LinkedInActor): Promise<LinkedInImagePlan> {
    await this.verifyAuthor(accessToken, actor);
    const response = await this.request(this.url("/rest/images?action=initializeUpload"), { method: "POST", headers: this.headers(accessToken),
      body: JSON.stringify({ initializeUploadRequest: { owner: actor.authorUrn } }) }, true);
    try {
      const value = object((await this.json(response)).value);
      return { type: "IMAGE", ownerUrn: actor.authorUrn, mediaUrn: this.mediaUrn(value.image, "image"),
        uploadUrl: this.uploadUrl(value.uploadUrl), expiresAt: this.expiry(value.uploadUrlExpiresAt) };
    } catch { throw new LinkedInError("PROVIDER_OUTCOME_UNKNOWN", 502, false, true); }
  }
  async initializeVideo(accessToken: string, actor: LinkedInActor, totalBytes: number): Promise<LinkedInVideoPlan> {
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 75000 || totalBytes > 500 * 1024 * 1024) return fail("INVALID_MEDIA", 400);
    await this.verifyAuthor(accessToken, actor);
    const response = await this.request(this.url("/rest/videos?action=initializeUpload"), { method: "POST", headers: this.headers(accessToken),
      body: JSON.stringify({ initializeUploadRequest: { owner: actor.authorUrn, fileSizeBytes: totalBytes, uploadCaptions: false, uploadThumbnail: false } }) }, true);
    try {
      const value = object((await this.json(response)).value);
      if (typeof value.uploadToken !== "string" || value.uploadToken.length > 32768 || !Array.isArray(value.uploadInstructions) || !value.uploadInstructions.length || value.uploadInstructions.length > 128) return fail();
      const parts = value.uploadInstructions.map((part) => {
        const row = object(part);
        if (!Number.isSafeInteger(row.firstByte) || !Number.isSafeInteger(row.lastByte) || Number(row.firstByte) < 0 || Number(row.lastByte) < Number(row.firstByte) || Number(row.lastByte) >= totalBytes) return fail();
        return { uploadUrl: this.uploadUrl(row.uploadUrl), firstByte: Number(row.firstByte), lastByte: Number(row.lastByte) };
      });
      if (parts[0].firstByte !== 0 || parts.at(-1)!.lastByte !== totalBytes - 1 || parts.some((part, index) =>
        part.lastByte - part.firstByte + 1 > 4194304 || (index > 0 && part.firstByte !== parts[index - 1].lastByte + 1))) return fail();
      return { type: "VIDEO", ownerUrn: actor.authorUrn, mediaUrn: this.mediaUrn(value.video, "video"), uploadToken: value.uploadToken,
        totalBytes, parts, expiresAt: this.expiry(value.uploadUrlsExpireAt) };
    } catch { throw new LinkedInError("PROVIDER_OUTCOME_UNKNOWN", 502, false, true); }
  }
  async uploadImage(accessToken: string, actor: LinkedInActor, plan: LinkedInImagePlan, bytes: Uint8Array) {
    const url = this.uploadUrl(plan.uploadUrl); this.expiry(plan.expiresAt);
    if (plan.type !== "IMAGE" || plan.ownerUrn !== actor.authorUrn) return fail("AUTHOR_MISMATCH", 403);
    this.mediaUrn(plan.mediaUrn, "image");
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > 64 * 1024 * 1024) return fail("INVALID_MEDIA", 400);
    await this.verifyAuthor(accessToken, actor);
    const response = await this.request(url, { method: "PUT", headers: { ...this.bearer(accessToken), "Content-Type": "application/octet-stream", "Content-Length": String(bytes.byteLength) },
      body: new Uint8Array(bytes).buffer }, true);
    await response.body?.cancel();
    if (![200, 201].includes(response.status)) throw new LinkedInError("PROVIDER_OUTCOME_UNKNOWN", 502, false, true);
  }
  async uploadPart(accessToken: string, actor: LinkedInActor, plan: LinkedInVideoPlan, index: number, bytes: Uint8Array) {
    this.expiry(plan.expiresAt); this.mediaUrn(plan.mediaUrn, "video");
    if (plan.type !== "VIDEO" || plan.ownerUrn !== actor.authorUrn) return fail("AUTHOR_MISMATCH", 403);
    const part = plan.parts[index];
    if (!Number.isSafeInteger(index) || !part || !(bytes instanceof Uint8Array) || bytes.byteLength !== part.lastByte - part.firstByte + 1) return fail("INVALID_MEDIA", 400);
    const url = this.uploadUrl(part.uploadUrl);
    await this.verifyAuthor(accessToken, actor);
    // Video upload URLs already carry a signed authorization. Never add OAuth credentials.
    const response = await this.request(url, { method: "PUT", headers: { "Content-Type": "application/octet-stream", "Content-Length": String(bytes.byteLength) }, body: new Uint8Array(bytes).buffer }, true);
    const raw = response.headers.get("etag"); await response.body?.cancel();
    if (response.status !== 200 || !raw || raw.length > 4096 || /[\r\n]/.test(raw)) throw new LinkedInError("PROVIDER_OUTCOME_UNKNOWN", 502, false, true);
    // Preserve opaque signed ETags; only remove the HTTP quoted-string wrapper.
    return raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  }
  async finalizeVideo(accessToken: string, actor: LinkedInActor, plan: LinkedInVideoPlan, partIds: readonly string[]) {
    this.mediaUrn(plan.mediaUrn, "video"); this.expiry(plan.expiresAt);
    if (plan.ownerUrn !== actor.authorUrn) return fail("AUTHOR_MISMATCH", 403);
    if (!Array.isArray(partIds) || partIds.length !== plan.parts.length || partIds.some((id) => typeof id !== "string" || !id || id.length > 4096 || /[\r\n]/.test(id))) return fail("INVALID_MEDIA", 400);
    await this.verifyAuthor(accessToken, actor);
    const response = await this.request(this.url("/rest/videos?action=finalizeUpload"), { method: "POST", headers: this.headers(accessToken),
      body: JSON.stringify({ finalizeUploadRequest: { video: plan.mediaUrn, uploadToken: plan.uploadToken, uploadedPartIds: [...partIds] } }) }, true);
    await response.body?.cancel(); if (response.status !== 200) throw new LinkedInError("PROVIDER_OUTCOME_UNKNOWN", 502, false, true);
  }
  async mediaStatus(accessToken: string, actor: LinkedInActor, mediaUrn: string): Promise<LinkedInMediaStatus> {
    const urn = this.mediaUrn(mediaUrn);
    await this.verifyAuthor(accessToken, { ...actor, requireWrite: false });
    const type = urn.startsWith("urn:li:image:") ? "images" : "videos";
    const value = await this.json(await this.request(this.url(`/rest/${type}/${encodeURIComponent(urn)}`), { headers: this.headers(accessToken) }));
    if (value.id !== urn || value.owner !== actor.authorUrn) return fail("AUTHOR_MISMATCH", 403);
    if (!["AVAILABLE", "PROCESSING", "PROCESSING_FAILED", "WAITING_UPLOAD"].includes(String(value.status))) return fail();
    return { mediaUrn: urn, ownerUrn: actor.authorUrn, status: value.status as LinkedInMediaStatus["status"] };
  }
  async createPost(accessToken: string, actor: LinkedInActor, input: LinkedInPostInput) {
    if (typeof input.commentary !== "string" || !input.commentary.trim() || input.commentary.length > 3000 ||
      !["PUBLIC", "CONNECTIONS"].includes(input.visibility) ||
      (actor.authorUrn.startsWith("urn:li:organization:") && input.visibility !== "PUBLIC") ||
      (input.title !== undefined && (typeof input.title !== "string" || input.title.length > 200))) return fail("INVALID_CONTENT", 400);
    await this.verifyAuthor(accessToken, actor);
    if (input.mediaUrn) {
      const media = await this.mediaStatus(accessToken, actor, input.mediaUrn);
      if (media.status !== "AVAILABLE") return fail(media.status === "PROCESSING_FAILED" ? "MEDIA_PROCESSING_FAILED" : "MEDIA_NOT_READY", 409);
    }
    const response = await this.request(this.url("/rest/posts"), { method: "POST", headers: this.headers(accessToken),
      body: JSON.stringify({ author: actor.authorUrn, commentary: linkedInPlainText(input.commentary), visibility: input.visibility,
        distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
        lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false,
        ...(input.mediaUrn ? { content: { media: { id: input.mediaUrn, ...(input.title ? { title: input.title } : {}) } } } : {}) }),
    }, true);
    const id = response.headers.get("x-restli-id"); await response.body?.cancel();
    try { if (response.status !== 201) return fail(); return { postUrn: this.postUrn(id) }; }
    catch { throw new LinkedInError("PROVIDER_OUTCOME_UNKNOWN", 502, false, true); }
  }
  async postStatus(accessToken: string, actor: LinkedInActor, postUrn: string): Promise<LinkedInPostStatus> {
    const urn = this.postUrn(postUrn);
    await this.verifyAuthor(accessToken, { ...actor, requireWrite: false });
    const row = await this.json(await this.request(this.url(`/rest/posts/${encodeURIComponent(urn)}?viewContext=AUTHOR`), { headers: this.headers(accessToken) }));
    if (row.id !== urn || row.author !== actor.authorUrn) return fail("AUTHOR_MISMATCH", 403);
    if (!(["PUBLIC", "CONNECTIONS"].includes(String(row.visibility))) || object(row.adContext ?? {}).isDsc === true ||
      !["PUBLISHED", "PUBLISH_REQUESTED", "PUBLISH_FAILED", "DRAFT"].includes(String(row.lifecycleState))) return fail();
    const media = row.content === undefined ? undefined : object(object(row.content).media).id;
    return { postUrn: urn, authorUrn: actor.authorUrn, visibility: row.visibility as LinkedInPostStatus["visibility"],
      ...(media !== undefined ? { mediaUrn: this.mediaUrn(media) } : {}), lifecycleState: String(row.lifecycleState),
      state: row.lifecycleState === "PUBLISHED" ? "PUBLISHED" : row.lifecycleState === "PUBLISH_REQUESTED" ? "PENDING" : row.lifecycleState === "PUBLISH_FAILED" ? "FAILED" : "DRAFT" };
  }
  async reconcileKnown(accessToken: string, actor: LinkedInActor, postUrn?: string) {
    return postUrn ? this.postStatus(accessToken, actor, postUrn) : { state: "UNKNOWN" as const };
  }
  async deleteKnownPost(accessToken: string, actor: LinkedInActor, postUrn: string) {
    await this.postStatus(accessToken, actor, postUrn);
    const verified = await this.verifyAuthor(accessToken, { ...actor, requireWrite: false });
    if (!verified.scopes.includes(actor.authorUrn.startsWith("urn:li:organization:") ? "w_organization_social" : "w_member_social")) return fail("MISSING_PERMISSION", 403);
    if (actor.authorUrn.startsWith("urn:li:organization:")) await this.organizationAction(accessToken, verified.personUrn, actor.authorUrn, "ORGANIC_SHARE_DELETE");
    const response = await this.request(this.url(`/rest/posts/${encodeURIComponent(this.postUrn(postUrn))}`), { method: "DELETE", headers: this.headers(accessToken) }, true);
    await response.body?.cancel(); if (response.status !== 204) throw new LinkedInError("PROVIDER_OUTCOME_UNKNOWN", 502, false, true);
    return { deleted: true as const };
  }
  private postUrn(value: unknown) { const urn = text(value, 512); if (!/^urn:li:(?:share|ugcPost):\d{1,30}$/.test(urn)) return fail(); return urn; }
  private mediaUrn(value: unknown, kind?: "image" | "video") {
    const urn = text(value, 512);
    if (!/^urn:li:(?:image|video):[A-Za-z0-9_-]{1,255}$/.test(urn) || (kind && !urn.startsWith(`urn:li:${kind}:`))) return fail();
    return urn;
  }
  private expiry(value: unknown) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= this.now().getTime()) return fail("MEDIA_EXPIRED", 409);
    return value;
  }
  private uploadUrl(value: unknown) {
    let url: URL; try { url = new URL(text(value, 16384)); } catch { return fail("INVALID_UPLOAD_URL", 400); }
    const trusted = this.origin ? url.origin === this.origin : ["https://www.linkedin.com", "https://www.linkedin-ei.com"].includes(url.origin);
    if (!trusted || url.username || url.password || url.hash || !/^\/dms-(?:mpf-)?uploads\//.test(url.pathname)) return fail("INVALID_UPLOAD_URL", 400);
    return url.href;
  }
  private async organizationAction(accessToken: string, personUrn: string, authorUrn: string, action: string) {
    const key = `(impersonator:${encodeURIComponent(personUrn)},organization:${encodeURIComponent(authorUrn)},action:(organizationContentAuthorizationAction:(actionType:${action})))`;
    const result = await this.json(await this.request(this.url(`/rest/organizationAuthorizations/${key}`), { headers: this.headers(accessToken) }));
    const actionValue = object(result.action);
    const actualAction = actionValue.OrganizationContentAuthorizationAction ?? actionValue.OrganizationContentAuthorizationActionType ?? actionValue.organizationContentAuthorizationAction;
    if (result.impersonator !== personUrn || result.organization !== authorUrn || object(actualAction).actionType !== action ||
      Object.keys(object(result.status)).length !== 1 || !("com.linkedin.organization.Approved" in object(result.status)))
      return fail("ORGANIZATION_ROLE_REQUIRED", 403);
  }
  private async grant(tokens: Json): Promise<LinkedInGrant> {
    const accessToken = text(tokens.access_token), suppliedScopes = scopeList(tokens.scope);
    const expiresAt = new Date(this.now().getTime() + seconds(tokens.expires_in) * 1000);
    if (!Number.isFinite(expiresAt.getTime())) return fail();
    const actual = await this.inspectToken(accessToken);
    if (this.scopes.some((scope) => !suppliedScopes.includes(scope) || !actual.scopes.includes(scope))) return fail("MISSING_PERMISSION", 403);
    const identity = await this.verifiedIdentity(accessToken);
    let refreshToken: string | undefined, refreshExpiresAt: Date | undefined;
    if (tokens.refresh_token !== undefined && this.config.mdpRefreshEnabled === true) {
      refreshToken = text(tokens.refresh_token); refreshExpiresAt = new Date(this.now().getTime() + seconds(tokens.refresh_token_expires_in) * 1000);
      if (!Number.isFinite(refreshExpiresAt.getTime())) return fail();
    }
    return { providerUserId: identity.providerUserId, personUrn: identity.personUrn, accessToken, scopes: actual.scopes,
      expiresAt: new Date(Math.min(expiresAt.getTime(), actual.expiresAt?.getTime() ?? Infinity)), ...(refreshToken ? { refreshToken, refreshExpiresAt } : {}) };
  }
  private url(path: string) { return new URL(path, this.origin ?? "https://api.linkedin.com").href; }
  private bearer(accessToken: string) { return { Authorization: `Bearer ${text(accessToken)}` }; }
  private headers(accessToken: string) { return { ...this.bearer(accessToken), "Linkedin-Version": LINKEDIN_VERSION, "X-Restli-Protocol-Version": "2.0.0", "Content-Type": "application/json" }; }
  private async form(path: string, parameters: Record<string, string>) {
    return this.json(await this.request(new URL(`/oauth/v2/${path}`, this.origin ?? "https://www.linkedin.com").href, { method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...parameters, client_id: this.config.clientId, client_secret: this.config.clientSecret }) }));
  }
  private async request(url: string, init: RequestInit = {}, mutation = false) {
    await this.config.beforeRequest?.();
    let response: Response;
    try { response = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(this.timeout) }); }
    catch { throw new LinkedInError(mutation ? "PROVIDER_OUTCOME_UNKNOWN" : "PROVIDER_UNAVAILABLE", 502, !mutation, mutation); }
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new LinkedInError(mutation ? "PROVIDER_OUTCOME_UNKNOWN" : "INVALID_PROVIDER_RESPONSE", 502, false, mutation); }
    if (!response.ok) {
      let error: Json = {}; try { error = await this.json(response); } catch { /* fixed safe messages only */ }
      const code = response.status === 401 || ["invalid_grant", "invalid_request"].includes(String(error.error)) ? "RECONNECT_REQUIRED" : response.status === 403 ? "MISSING_PERMISSION" : response.status === 429 ? "PROVIDER_RATE_LIMITED" : mutation && response.status >= 500 ? "PROVIDER_OUTCOME_UNKNOWN" : "PROVIDER_REQUEST_FAILED";
      throw new LinkedInError(code, response.status >= 500 ? 502 : response.status, !mutation && (response.status === 429 || response.status >= 500), code === "PROVIDER_OUTCOME_UNKNOWN");
    }
    return response;
  }
  private async json(response: Response): Promise<Json> {
    if (!response.body) return fail(); const chunks: Uint8Array[] = []; let length = 0;
    const reader = response.body.getReader();
    try { while (true) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > 1024 * 1024) { await reader.cancel(); return fail(); } chunks.push(value); }
      return object(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { return fail(); }
  }
}
