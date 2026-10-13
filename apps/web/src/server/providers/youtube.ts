import { SecurityError } from "../security/errors";
import { mockoonOrigin } from "./providerHttp";

export const YOUTUBE_SCOPES = ["openid", "https://www.googleapis.com/auth/youtube.force-ssl"] as const;
export const YOUTUBE_CHUNK_BYTES = 256 * 1024;

export class YouTubeError extends SecurityError {
  constructor(code: string, status = 502, readonly retryable = false, readonly outcomeUnknown = false) {
    const messages: Record<string, string> = {
      RECONNECT_REQUIRED: "Reconnect YouTube to restore access.",
      MISSING_PERMISSION: "Reconnect and grant YouTube publishing and identity permission.",
      PROVIDER_IDENTITY_MISMATCH: "Reconnect using the original Google identity.",
      CHANNEL_MISMATCH: "Choose the verified YouTube channel for this operation.",
      INVALID_MEDIA: "Choose a square or vertical supported video up to three minutes.",
      INVALID_SCHEDULE: "Choose a future time for a private, never-published video.",
      UPLOAD_SESSION_EXPIRED: "The upload session expired. Reconcile before starting another upload.",
      PROVIDER_OUTCOME_UNKNOWN: "The provider outcome is uncertain. Reconcile before retrying.",
      VIDEO_NOT_FOUND: "The expected video could not be found.",
      PROVIDER_QUOTA_EXCEEDED: "YouTube quota is exhausted. Check the project allocation.",
      PROVIDER_RATE_LIMITED: "YouTube request limits were reached. Try again later.",
    };
    super(code, status, messages[code] ?? "The YouTube request could not be completed.");
    this.name = "YouTubeError";
  }
}

export type YouTubeConfig = {
  clientId: string; clientSecret: string; redirectUri: string;
  mockoonEnabled?: boolean; mockoonBaseUrl?: string;
  requestTimeoutMs?: number; now?: () => Date;
  /** Durable worker guard; executes immediately before every network send. */
  beforeRequest?: () => Promise<void>;
};
export type YouTubeGrant = {
  providerUserId: string; accessToken: string; refreshToken: string; scopes: string[]; expiresAt: Date;
};
export type YouTubeChannel = { id: string; title: string; description: string };
export type YouTubeMedia = {
  mimeType: string; byteLength: number; width: number; height: number; durationSeconds: number; rotationDegrees?: number;
};
export type YouTubeUploadInput = {
  media: YouTubeMedia; title: string; description: string; categoryId: string;
  privacyStatus: "private" | "unlisted" | "public";
  selfDeclaredMadeForKids: boolean; containsSyntheticMedia: boolean; publishAt?: string;
};
export type YouTubeUploadProgress = { state: "UPLOADING"; nextOffset: number } | { state: "UPLOADED"; videoId: string };
export type YouTubeMutableStatus = {
  privacyStatus: "private" | "unlisted" | "public"; publishAt?: string;
  embeddable?: boolean; license?: "youtube" | "creativeCommon"; publicStatsViewable?: boolean;
  selfDeclaredMadeForKids?: boolean; containsSyntheticMedia?: boolean;
};
export type YouTubeVideoStatus = {
  id: string; channelId: string; title: string; description: string; status: YouTubeMutableStatus;
  uploadStatus: string; processingStatus: string;
  state: "PROCESSING" | "READY" | "SCHEDULED" | "PUBLISHED" | "FAILED";
};
export type YouTubeReconciliation = YouTubeUploadProgress | { state: "KNOWN"; video: YouTubeVideoStatus } | { state: "UNRESOLVED" };

/** Input must come from a trusted decoded-media probe, never browser assertions. */
export function validateShortsMedia(media: YouTubeMedia) {
  if (!media || typeof media !== "object") return reject("INVALID_MEDIA", 400);
  const rotation = ((media.rotationDegrees ?? 0) % 360 + 360) % 360;
  if (!media || !["video/mp4", "video/webm", "video/quicktime"].includes(media.mimeType) ||
    !Number.isSafeInteger(media.byteLength) || media.byteLength < 1 || media.byteLength > 256 * 1024 ** 3 ||
    !Number.isSafeInteger(media.width) || !Number.isSafeInteger(media.height) || media.width < 1 || media.height < 1 ||
    !Number.isFinite(media.durationSeconds) || media.durationSeconds <= 0 || media.durationSeconds > 180 ||
    ![0, 90, 180, 270].includes(rotation)) return reject("INVALID_MEDIA", 400);
  const swap = rotation === 90 || rotation === 270;
  const displayWidth = swap ? media.height : media.width;
  const displayHeight = swap ? media.width : media.height;
  if (displayWidth > displayHeight) return reject("INVALID_MEDIA", 400);
  return { ...media, displayWidth, displayHeight, rotationDegrees: rotation };
}
type Json = Record<string, unknown>;
const reject = (code = "INVALID_PROVIDER_RESPONSE", status = 502): never => { throw new YouTubeError(code, status); };
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) return reject();
  return value as Json;
}
function text(value: unknown, maximum = 32768): string {
  if (typeof value !== "string" || !value || value.length > maximum) return reject();
  return value;
}
function identifier(value: unknown) {
  const id = text(value, 128);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return reject();
  return id;
}

/** Stateless server client. Session, capability, selection and durable checkpoints belong above it. */
export class YouTubeClient {
  readonly scopes = [...YOUTUBE_SCOPES];
  readonly pkce = true;
  readonly redirectUri!: string;
  private readonly mockOrigin?: string;
  private readonly now!: () => Date;
  private readonly timeout!: number;

  constructor(private readonly config: YouTubeConfig) {
    if (!config.clientId || config.clientId.length > 512 || !config.clientSecret || config.clientSecret.length > 32768)
      return reject("INVALID_CONFIG", 503);
    if (config.mockoonBaseUrl && config.mockoonEnabled !== true) return reject("INVALID_CONFIG", 503);
    this.mockOrigin = mockoonOrigin(config.mockoonBaseUrl);
    let callback: URL;
    try { callback = new URL(config.redirectUri); } catch { return reject("INVALID_CONFIG", 503); }
    if (callback.username || callback.password || callback.search || callback.hash ||
      (callback.protocol !== "https:" && !(this.mockOrigin && callback.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname)))) return reject("INVALID_CONFIG", 503);
    this.redirectUri = callback.href;
    this.timeout = config.requestTimeoutMs ?? 20_000;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 1 || this.timeout > 60_000) return reject("INVALID_CONFIG", 503);
    this.now = config.now ?? (() => new Date());
  }

  authorizationUrl(input: { state: string; codeChallenge: string }) {
    if (!input.state || input.state.length > 1024 || !/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge))
      return reject("INVALID_OAUTH_STATE", 400);
    const url = new URL("/o/oauth2/v2/auth", this.mockOrigin ?? "https://accounts.google.com");
    url.search = new URLSearchParams({ client_id: this.config.clientId, redirect_uri: this.redirectUri,
      response_type: "code", scope: this.scopes.join(" "), state: input.state,
      access_type: "offline", prompt: "consent select_account",
      code_challenge: input.codeChallenge, code_challenge_method: "S256" }).toString();
    return url.href;
  }

  async exchangeCode(input: { code: string; codeVerifier: string;
    previous?: { providerUserId: string; refreshToken: string } }): Promise<YouTubeGrant> {
    if (!input.code || input.code.length > 4096 || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier))
      return reject("INVALID_OAUTH_STATE", 400);
    return this.verifiedGrant(await this.token({ grant_type: "authorization_code", code: input.code,
      code_verifier: input.codeVerifier, redirect_uri: this.redirectUri }), input.previous);
  }

  async renewVerified(input: { providerUserId: string; refreshToken: string; scopes: string[] }): Promise<YouTubeGrant> {
    if (!input.refreshToken) return reject("RECONNECT_REQUIRED", 409);
    return this.verifiedGrant(await this.token({ grant_type: "refresh_token", refresh_token: input.refreshToken }), input, input.scopes);
  }

  async discoverChannels(accessToken: string): Promise<YouTubeChannel[]> {
    const channels = new Map<string, YouTubeChannel>();
    const seen = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < 100; page++) {
      const result = await this.json(await this.request(this.api("channels", {
        part: "snippet,status", mine: "true", maxResults: "50", ...(pageToken ? { pageToken } : {}),
      }), { headers: this.bearer(accessToken) }));
      if (!Array.isArray(result.items)) return reject();
      for (const value of result.items) {
        const row = object(value); const snippet = object(row.snippet); const id = identifier(row.id);
        channels.set(id, { id, title: text(snippet.title, 512),
          description: typeof snippet.description === "string" ? snippet.description.slice(0, 5000) : "" });
      }
      if (result.nextPageToken === undefined) return [...channels.values()];
      pageToken = text(result.nextPageToken, 4096);
      if (seen.has(pageToken)) return reject();
      seen.add(pageToken);
    }
    return reject();
  }

  async verifyChannel(accessToken: string, channelId: string): Promise<YouTubeChannel> {
    identifier(channelId);
    const channel = (await this.discoverChannels(accessToken)).find((row) => row.id === channelId);
    if (!channel) return reject("CHANNEL_MISMATCH", 403);
    return channel;
  }

  async startResumable(accessToken: string, channelId: string, input: YouTubeUploadInput) {
    const media = validateShortsMedia(input.media);
    if (!input.title || input.title.length > 100 || /[<>]/.test(input.title) || typeof input.description !== "string" ||
      Buffer.byteLength(input.description, "utf8") > 5000 || !/^\d{1,3}$/.test(input.categoryId) ||
      !["private", "unlisted", "public"].includes(input.privacyStatus) ||
      typeof input.selfDeclaredMadeForKids !== "boolean" || typeof input.containsSyntheticMedia !== "boolean")
      return reject("INVALID_CONTENT", 400);
    if (input.publishAt !== undefined && input.privacyStatus !== "private") return reject("INVALID_SCHEDULE", 400);
    const publishAt = input.publishAt === undefined ? undefined : this.futureTime(input.publishAt);
    // Standard user OAuth uploads to the channel selected during consent. There
    // is no ordinary channelId selector; a CMS-only delegation is another flow.
    const channels = await this.discoverChannels(accessToken);
    if (channels.length !== 1 || channels[0].id !== channelId) return reject("CHANNEL_MISMATCH", 403);
    const url = new URL("/upload/youtube/v3/videos", this.mockOrigin ?? "https://www.googleapis.com");
    url.search = new URLSearchParams({ uploadType: "resumable", part: "snippet,status" }).toString();
    const response = await this.request(url.href, { method: "POST",
      headers: { ...this.bearer(accessToken), "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(media.byteLength), "X-Upload-Content-Type": media.mimeType },
      body: JSON.stringify({ snippet: { title: input.title, description: input.description, categoryId: input.categoryId },
        status: { privacyStatus: input.privacyStatus, selfDeclaredMadeForKids: input.selfDeclaredMadeForKids,
          containsSyntheticMedia: input.containsSyntheticMedia, ...(publishAt ? { publishAt } : {}) } }),
    }, true);
    const location = response.headers.get("location");
    await response.body?.cancel();
    try { return { sessionUrl: this.sessionUrl(location), totalBytes: media.byteLength, mimeType: media.mimeType, channelId }; }
    catch { throw new YouTubeError("PROVIDER_OUTCOME_UNKNOWN", 502, false, true); }
  }

  async uploadChunk(accessToken: string, sessionUrl: string, input: {
    offset: number; totalBytes: number; mimeType: string; bytes: Uint8Array; channelId: string;
  }): Promise<YouTubeUploadProgress> {
    const url = this.sessionUrl(sessionUrl);
    this.totalBytes(input.totalBytes);
    if (!Number.isSafeInteger(input.offset) || input.offset < 0 || !(input.bytes instanceof Uint8Array) ||
      input.bytes.byteLength === 0 || input.offset + input.bytes.byteLength > input.totalBytes ||
      (input.offset + input.bytes.byteLength < input.totalBytes && input.bytes.byteLength % YOUTUBE_CHUNK_BYTES !== 0) ||
      !["video/mp4", "video/webm", "video/quicktime"].includes(input.mimeType)) return reject("INVALID_UPLOAD_CHUNK", 400);
    await this.verifyChannel(accessToken, input.channelId);
    const response = await this.request(url, { method: "PUT", headers: { ...this.bearer(accessToken),
      "Content-Type": input.mimeType, "Content-Length": String(input.bytes.byteLength),
      "Content-Range": `bytes ${input.offset}-${input.offset + input.bytes.byteLength - 1}/${input.totalBytes}` },
      body: new Uint8Array(input.bytes).buffer }, true, true);
    return this.uploadProgress(response, input.totalBytes, input.channelId);
  }

  async probeUpload(accessToken: string, sessionUrl: string, input: { totalBytes: number; channelId: string }): Promise<YouTubeUploadProgress> {
    const url = this.sessionUrl(sessionUrl); this.totalBytes(input.totalBytes);
    await this.verifyChannel(accessToken, input.channelId);
    const response = await this.request(url, { method: "PUT", headers: { ...this.bearer(accessToken),
      "Content-Length": "0", "Content-Range": `bytes */${input.totalBytes}` }, body: "" }, false, true);
    return this.uploadProgress(response, input.totalBytes, input.channelId);
  }

  async videoStatus(accessToken: string, videoId: string, channelId: string): Promise<YouTubeVideoStatus> {
    identifier(videoId); await this.verifyChannel(accessToken, channelId);
    const result = await this.json(await this.request(this.api("videos", {
      part: "snippet,status,processingDetails", id: videoId,
    }), { headers: this.bearer(accessToken) }));
    if (!Array.isArray(result.items)) return reject();
    if (result.items.length === 0) return reject("VIDEO_NOT_FOUND", 404);
    if (result.items.length !== 1) return reject();
    const row = object(result.items[0]); const snippet = object(row.snippet); const rawStatus = object(row.status);
    if (identifier(row.id) !== videoId || identifier(snippet.channelId) !== channelId) return reject("CHANNEL_MISMATCH", 403);
    const status = this.mutableStatus(rawStatus);
    const uploadStatus = text(rawStatus.uploadStatus, 64);
    if (!["deleted", "failed", "processed", "rejected", "uploaded"].includes(uploadStatus)) return reject();
    const processingStatus = row.processingDetails === undefined ? (uploadStatus === "processed" ? "succeeded" : "processing")
      : text(object(row.processingDetails).processingStatus, 64);
    if (!["processing", "succeeded", "failed", "terminated"].includes(processingStatus)) return reject();
    let state: YouTubeVideoStatus["state"];
    if (["deleted", "failed", "rejected"].includes(uploadStatus) || ["failed", "terminated"].includes(processingStatus)) state = "FAILED";
    else if (status.privacyStatus === "private" && status.publishAt && new Date(status.publishAt) > this.now()) state = "SCHEDULED";
    else if (uploadStatus !== "processed" || processingStatus !== "succeeded") state = "PROCESSING";
    else state = status.privacyStatus === "private" ? "READY" : "PUBLISHED";
    return { id: videoId, channelId, title: text(snippet.title, 100),
      description: typeof snippet.description === "string" ? snippet.description.slice(0, 5000) : "", status, uploadStatus, processingStatus, state };
  }

  async reconcile(accessToken: string, channelId: string, saved: {
    videoId?: string; sessionUrl?: string; totalBytes?: number;
  }): Promise<YouTubeReconciliation> {
    if (saved.videoId) return { state: "KNOWN", video: await this.videoStatus(accessToken, saved.videoId, channelId) };
    if (saved.sessionUrl) {
      if (saved.totalBytes === undefined) return reject("INVALID_UPLOAD_SESSION", 400);
      return this.probeUpload(accessToken, saved.sessionUrl, { totalBytes: saved.totalBytes, channelId });
    }
    return { state: "UNRESOLVED" };
  }

  async updateSchedule(accessToken: string, videoId: string, channelId: string, publishAt: string) {
    const time = this.futureTime(publishAt);
    const current = await this.videoStatus(accessToken, videoId, channelId);
    if (current.status.privacyStatus !== "private" || current.state === "FAILED") return reject("INVALID_SCHEDULE", 409);
    // The provider additionally enforces never-published history, which cannot
    // be inferred from snippet.publishedAt (private uploads also have that date).
    await this.writeStatus(accessToken, videoId, { ...current.status, privacyStatus: "private", publishAt: time });
    const verified = await this.videoStatus(accessToken, videoId, channelId);
    if (verified.status.privacyStatus !== "private" || verified.status.publishAt !== time)
      throw new YouTubeError("PROVIDER_OUTCOME_UNKNOWN", 502, false, true);
    return verified;
  }

  async cancelSchedule(accessToken: string, videoId: string, channelId: string) {
    const current = await this.videoStatus(accessToken, videoId, channelId);
    if (current.status.privacyStatus !== "private") return reject("INVALID_SCHEDULE", 409);
    if (current.status.publishAt === undefined) return current;
    if (new Date(current.status.publishAt) <= this.now()) return reject("INVALID_SCHEDULE", 409);
    const status = { ...current.status }; delete status.publishAt;
    // part=status replaces omitted properties. Preserve every other available
    // mutable status field, including false-valued audience/disclosure settings.
    await this.writeStatus(accessToken, videoId, status);
    const verified = await this.videoStatus(accessToken, videoId, channelId);
    if (verified.status.privacyStatus !== "private" || verified.status.publishAt !== undefined)
      throw new YouTubeError("PROVIDER_OUTCOME_UNKNOWN", 502, false, true);
    return verified;
  }

  async deleteVideo(accessToken: string, videoId: string, channelId: string) {
    // Delete only an explicit known ID after verifying its actual owning channel.
    await this.videoStatus(accessToken, videoId, channelId);
    const response = await this.request(this.api("videos", { id: identifier(videoId) }), {
      method: "DELETE", headers: this.bearer(accessToken),
    }, true);
    await response.body?.cancel();
    if (response.status !== 204) throw new YouTubeError("PROVIDER_OUTCOME_UNKNOWN", 502, false, true);
    return { deleted: true as const };
  }

  private async writeStatus(accessToken: string, videoId: string, status: YouTubeMutableStatus) {
    const response = await this.request(this.api("videos", { part: "status" }), { method: "PUT",
      headers: { ...this.bearer(accessToken), "Content-Type": "application/json" },
      body: JSON.stringify({ id: videoId, status }) }, true);
    try { if ((await this.json(response)).id !== videoId) throw new Error("Invalid update receipt"); }
    catch { throw new YouTubeError("PROVIDER_OUTCOME_UNKNOWN", 502, false, true); }
  }

  private mutableStatus(raw: Json): YouTubeMutableStatus {
    if (!["private", "unlisted", "public"].includes(String(raw.privacyStatus))) return reject();
    const status: YouTubeMutableStatus = { privacyStatus: raw.privacyStatus as YouTubeMutableStatus["privacyStatus"] };
    for (const key of ["embeddable", "publicStatsViewable", "selfDeclaredMadeForKids", "containsSyntheticMedia"] as const) {
      if (raw[key] !== undefined) { if (typeof raw[key] !== "boolean") return reject(); status[key] = raw[key]; }
    }
    if (raw.license !== undefined) {
      if (raw.license !== "youtube" && raw.license !== "creativeCommon") return reject(); status.license = raw.license;
    }
    if (raw.publishAt !== undefined) {
      const date = new Date(text(raw.publishAt, 64)); if (!Number.isFinite(date.getTime())) return reject();
      status.publishAt = date.toISOString();
    }
    return status;
  }

  private async uploadProgress(response: Response, totalBytes: number, channelId: string): Promise<YouTubeUploadProgress> {
    if (response.status === 308) {
      const range = response.headers.get("range"); await response.body?.cancel();
      if (range === null) return { state: "UPLOADING", nextOffset: 0 };
      const match = /^bytes=0-(\d+)$/.exec(range);
      const nextOffset = match ? Number(match[1]) + 1 : NaN;
      if (!Number.isSafeInteger(nextOffset) || nextOffset < 1 || nextOffset > totalBytes)
        throw new YouTubeError("PROVIDER_OUTCOME_UNKNOWN", 502, false, true);
      return { state: "UPLOADING", nextOffset };
    }
    try {
      const row = await this.json(response);
      if (object(row.snippet).channelId !== channelId) throw new YouTubeError("CHANNEL_MISMATCH", 403, false, true);
      return { state: "UPLOADED", videoId: identifier(row.id) };
    } catch (error) {
      if (error instanceof YouTubeError && error.code === "CHANNEL_MISMATCH") throw error;
      throw new YouTubeError("PROVIDER_OUTCOME_UNKNOWN", 502, false, true);
    }
  }

  private totalBytes(value: number) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 256 * 1024 ** 3) return reject("INVALID_MEDIA", 400);
  }

  private futureTime(value: string) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))
      return reject("INVALID_SCHEDULE", 400);
    const date = new Date(value);
    const calendar = value.slice(0, 19);
    const calendarDate = new Date(`${calendar}Z`);
    if (!Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 19) !== calendar ||
      !Number.isFinite(date.getTime()) || date <= this.now()) return reject("INVALID_SCHEDULE", 400);
    return date.toISOString();
  }

  private sessionUrl(value: unknown) {
    let url: URL;
    try { url = new URL(text(value, 8192)); } catch { return reject("INVALID_UPLOAD_SESSION", 400); }
    if (url.origin !== (this.mockOrigin ?? "https://www.googleapis.com") || url.username || url.password || url.hash ||
      url.pathname !== "/upload/youtube/v3/videos" || url.searchParams.get("uploadType") !== "resumable" ||
      !url.searchParams.get("upload_id") || url.searchParams.get("upload_id")!.length > 4096)
      return reject("INVALID_UPLOAD_SESSION", 400);
    return url.href;
  }

  private api(path: string, parameters: Record<string, string> = {}) {
    const url = new URL(`/youtube/v3/${path}`, this.mockOrigin ?? "https://www.googleapis.com");
    url.search = new URLSearchParams(parameters).toString(); return url.href;
  }

  private async token(parameters: Record<string, string>) {
    // Google offline refresh tokens are reusable. Code exchanges and publication submissions remain nonretryable.
    const response = await this.request(new URL("/token", this.mockOrigin ?? "https://oauth2.googleapis.com").href, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...parameters, client_id: this.config.clientId, client_secret: this.config.clientSecret }),
    }, false, parameters.grant_type === "refresh_token");
    // The shared read flag also permits resumable-upload308. A token response must never take that branch.
    if (response.status === 308) { await response.body?.cancel(); return reject("INVALID_PROVIDER_RESPONSE", 502); }
    return this.json(response);
  }

  private async verifiedGrant(tokens: Json, previous?: { providerUserId: string; refreshToken: string }, priorScopes?: string[]) {
    const accessToken = text(tokens.access_token);
    if (typeof tokens.token_type !== "string" || tokens.token_type.toLowerCase() !== "bearer" ||
      typeof tokens.expires_in !== "number" || !Number.isSafeInteger(tokens.expires_in) || tokens.expires_in <= 0) return reject();
    const expiresAt = new Date(this.now().getTime() + tokens.expires_in * 1000);
    if (!Number.isFinite(expiresAt.getTime())) return reject();
    const scopes = typeof tokens.scope === "string" ? tokens.scope.split(/\s+/).filter(Boolean) : priorScopes;
    if (!Array.isArray(scopes) || this.scopes.some((scope) => !scopes.includes(scope))) return reject("MISSING_PERMISSION", 403);
    const identity = await this.json(await this.request(new URL("/v1/userinfo", this.mockOrigin ?? "https://openidconnect.googleapis.com").href,
      { headers: this.bearer(accessToken) }));
    const providerUserId = text(identity.sub, 255);
    if (previous && previous.providerUserId !== providerUserId) return reject("PROVIDER_IDENTITY_MISMATCH", 409);
    const refreshToken = typeof tokens.refresh_token === "string" && tokens.refresh_token
      ? text(tokens.refresh_token) : previous?.refreshToken;
    if (!refreshToken) return reject("RECONNECT_REQUIRED", 409);
    return { providerUserId, accessToken, refreshToken, scopes: [...new Set(scopes)], expiresAt };
  }

  private bearer(token: string) { return { Authorization: `Bearer ${text(token)}` }; }

  private async request(url: string, input: RequestInit = {}, mutation = false, incomplete = false) {
    const safeRead = !mutation && (incomplete || !input.method || input.method === "GET");
    // Preserve guard failures so lease/ownership failures cannot become a retry.
    await this.config.beforeRequest?.();
    let response: Response;
    try { response = await fetch(url, { ...input, redirect: "manual", signal: AbortSignal.timeout(this.timeout) }); }
    catch { throw new YouTubeError(mutation ? "PROVIDER_OUTCOME_UNKNOWN" : "PROVIDER_UNAVAILABLE", 502, safeRead, mutation); }
    if (incomplete && response.status === 308) return response;
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new YouTubeError(mutation ? "PROVIDER_OUTCOME_UNKNOWN" : "INVALID_PROVIDER_RESPONSE", 502, false, mutation);
    }
    if (!response.ok) {
      let body: Json = {};
      try { body = await this.json(response); } catch { /* Never reflect raw provider text. */ }
      const error = body.error && typeof body.error === "object" ? object(body.error) : {};
      const reasons = Array.isArray(error.errors) ? error.errors.map((value) => object(value).reason) : [];
      const code = incomplete && [404, 410].includes(response.status) ? "UPLOAD_SESSION_EXPIRED"
        : body.error === "invalid_grant" || response.status === 401 ? "RECONNECT_REQUIRED"
        : reasons.some((reason) => ["quotaExceeded", "dailyLimitExceeded", "uploadLimitExceeded"].includes(String(reason))) ? "PROVIDER_QUOTA_EXCEEDED"
        : response.status === 403 ? "MISSING_PERMISSION"
        : response.status === 429 ? "PROVIDER_RATE_LIMITED"
        : mutation && response.status >= 500 ? "PROVIDER_OUTCOME_UNKNOWN" : "PROVIDER_REQUEST_FAILED";
      throw new YouTubeError(code, response.status >= 500 ? 502 : response.status,
        safeRead && (response.status === 429 || response.status >= 500), ["PROVIDER_OUTCOME_UNKNOWN", "UPLOAD_SESSION_EXPIRED"].includes(code));
    }
    return response;
  }

  private async json(response: Response): Promise<Json> {
    if (!response.body) return reject();
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) { const { done, value } = await reader.read(); if (done) break;
        length += value.byteLength;
        if (length > 1024 * 1024) { await reader.cancel(); return reject(); }
        chunks.push(value);
      }
      return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch { return reject(); }
  }
}
