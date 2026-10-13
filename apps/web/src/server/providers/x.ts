import { createHash } from "node:crypto";
import twitterText from "twitter-text";
const { parseTweet, extractUrls } = twitterText;
import { SecurityError } from "../security/errors";
import { mockoonOrigin, record } from "./providerHttp";

export const X_SCOPES = [
  "tweet.read",
  "users.read",
  "tweet.write",
  "media.write",
  "offline.access",
] as const;
export const X_CHUNK_BYTES = 4 * 1024 * 1024;
export type XOperation =
  | "USER_READ"
  | "POST_READ"
  | "POST_CREATE"
  | "POST_CREATE_URL"
  | "POST_DELETE"
  | "MEDIA_UPLOAD"
  | "MEDIA_INIT"
  | "MEDIA_APPEND"
  | "MEDIA_FINALIZE"
  | "MEDIA_STATUS";
export type XPriceSchedule = Readonly<Record<XOperation, number>>;
export type XConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  mockoonBaseUrl?: string;
  mockoonEnabled?: boolean;
  requestTimeoutMs?: number;
  now?: () => Date;
  beforeRequest?: () => Promise<void>;
  beforeBillableRequest?: (operation: XOperation) => Promise<void>;
};
export type XGrant = {
  providerUserId: string;
  name: string;
  username: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scopes: string[];
};
export type XMedia = {
  mime: string;
  bytes: number;
  width: number;
  height: number;
  durationMs: number | null;
  metadata?: unknown;
};
export type XMediaReceipt = {
  id: string;
  mediaKey?: string;
  expiresAt?: Date;
  state: "pending" | "in_progress" | "succeeded" | "failed";
  checkAfterMs: number;
};
export type XPost = {
  id: string;
  authorId: string;
  text: string;
  mediaKeys: string[];
};
export class XError extends SecurityError {
  constructor(
    code: string,
    status = 502,
    readonly retryable = false,
    readonly outcomeUnknown = false,
    readonly retryAfterMs?: number,
  ) {
    super(
      code,
      status,
      (
        {
          INVALID_CONFIG: "X is not configured for this environment.",
          RECONNECT_REQUIRED:
            "Reconnect X and approve the required access again.",
          MISSING_PERMISSION: "Approve X profile, post and media permissions.",
          PROVIDER_IDENTITY_MISMATCH: "Reconnect with the original X account.",
          PROVIDER_RATE_LIMITED:
            "X request limits were reached. Try again later.",
          PROVIDER_CREDITS_REQUIRED:
            "X API credits or the console spending allowance are unavailable.",
          PROVIDER_PERMISSION_DENIED: "X did not allow this operation.",
          POST_NOT_FOUND: "X could not verify this post.",
          INVALID_CONTENT: "Review the X text, media and disclosure choices.",
          INVALID_MEDIA:
            "Choose inspected media supported by this X publishing release.",
          INVALID_PROVIDER_RESPONSE: "X returned an incomplete response.",
          PROVIDER_UNAVAILABLE: "X could not be reached. Try again later.",
        } as Record<string, string>
      )[code] ?? "X could not complete this request.",
    );
  }
}
function reject(code = "INVALID_PROVIDER_RESPONSE", status = 502): never {
  throw new XError(code, status);
}
function text(value: unknown, max = 32768) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    reject();
  return value as string;
}
function id(value: unknown) {
  const result = text(value, 19);
  if (!/^[0-9]{1,19}$/.test(result)) reject();
  return result;
}
/** Official twitter-text performs URL/emoji weighting and NFC validation. */
export function validateXText(value: string, mediaCount = 0) {
  if (
    typeof value !== "string" ||
    value.length > 10000 ||
    /[\u0000\ufffe\uffff]/.test(value)
  )
    reject("INVALID_CONTENT", 400);
  const result = parseTweet(value);
  if (
    (value.trim().length === 0 && !mediaCount) ||
    (value.length > 0 && !result.valid)
  )
    reject("INVALID_CONTENT", 400);
  return {
    text: value.normalize("NFC"),
    weightedLength: result.weightedLength,
    hasUrls: extractUrls(value).length > 0,
  };
}
export function validateXMedia(media: XMedia, format: "IMAGE" | "SHORT_VIDEO") {
  if (
    !media ||
    !Number.isSafeInteger(media.bytes) ||
    media.bytes < 1 ||
    !Number.isSafeInteger(media.width) ||
    !Number.isSafeInteger(media.height) ||
    media.width < 1 ||
    media.height < 1
  )
    reject("INVALID_MEDIA", 400);
  if (format === "IMAGE") {
    // Animated GIF support requires different validation and is outside this release.
    if (
      !["image/jpeg", "image/png", "image/webp"].includes(media.mime) ||
      media.bytes > 5_000_000 ||
      media.durationMs !== null
    )
      reject("INVALID_MEDIA", 400);
  } else {
    const m = record(media.metadata);
    if (
      media.mime !== "video/mp4" ||
      media.bytes > 8_000_000_000 ||
      typeof media.durationMs !== "number" ||
      media.durationMs < 500 ||
      media.durationMs > 1200000 ||
      m.videoCodec !== "h264" ||
      typeof m.fps !== "number" ||
      !Number.isFinite(m.fps) ||
      m.fps <= 0 ||
      m.fps > 60 ||
      Math.min(media.width, media.height) < 32 ||
      Math.max(media.width, media.height) > 1280 ||
      Math.min(media.width, media.height) > 1024 ||
      media.width / media.height < 1 / 3 ||
      media.width / media.height > 3 ||
      (m.audioCodec !== undefined && m.audioCodec !== "aac")
    )
      reject("INVALID_MEDIA", 400);
  }
  return media;
}
export function xCostEstimate(
  textValue: string,
  format: "TEXT" | "IMAGE" | "SHORT_VIDEO",
  media: readonly XMedia[],
  prices: XPriceSchedule,
) {
  for (const price of Object.values(prices))
    if (!Number.isSafeInteger(price) || price < 0)
      reject("INVALID_CONFIG", 503);
  const validated = validateXText(textValue, media.length);
  const create = prices[validated.hasUrls ? "POST_CREATE_URL" : "POST_CREATE"];
  const base = 3 * prices.USER_READ + create + prices.POST_READ;
  const cost =
    format === "TEXT"
      ? base
      : format === "IMAGE"
        ? base + media.length * prices.MEDIA_UPLOAD
        : base +
          prices.MEDIA_INIT +
          Math.ceil(media[0].bytes / X_CHUNK_BYTES) * prices.MEDIA_APPEND +
          prices.MEDIA_FINALIZE +
          prices.MEDIA_STATUS;
  if (!Number.isSafeInteger(cost) || cost < 0) reject("INVALID_CONFIG", 503);
  return cost;
}

/** Fixed v2 provider hosts. All user/media identifiers are validated before path construction. */
export class XClient {
  readonly pkce = true;
  readonly scopes = [...X_SCOPES];
  readonly mode: "mock" | "live";
  readonly redirectUri: string;
  private readonly origin: string;
  private readonly authOrigin: string;
  private readonly now: () => Date;
  private readonly timeout: number;
  constructor(private readonly config: XConfig) {
    if (
      !config.clientId ||
      !config.clientSecret ||
      config.clientId.length > 512 ||
      config.clientSecret.length > 32768 ||
      /[\r\n]/.test(config.clientId + config.clientSecret) ||
      (config.mockoonBaseUrl && config.mockoonEnabled !== true) ||
      (config.mockoonEnabled === true && !config.mockoonBaseUrl)
    )
      reject("INVALID_CONFIG", 503);
    const mock = mockoonOrigin(config.mockoonBaseUrl);
    this.mode = mock ? "mock" : "live";
    this.origin = mock ?? "https://api.x.com";
    this.authOrigin = mock ?? "https://x.com";
    let uri: URL;
    try {
      uri = new URL(config.redirectUri);
    } catch {
      reject("INVALID_CONFIG", 503);
    }
    if (
      uri.username ||
      uri.password ||
      uri.hash ||
      uri.search ||
      !(
        uri.protocol === "https:" ||
        (mock &&
          uri.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(uri.hostname))
      )
    )
      reject("INVALID_CONFIG", 503);
    this.redirectUri = uri.href;
    this.now = config.now ?? (() => new Date());
    this.timeout = config.requestTimeoutMs ?? 20000;
    if (
      !Number.isSafeInteger(this.timeout) ||
      this.timeout < 1 ||
      this.timeout > 60000
    )
      reject("INVALID_CONFIG", 503);
  }
  authorizationUrl(input: { state: string; codeChallenge: string }) {
    if (
      !/^[A-Za-z0-9_-]{16,500}$/.test(input.state) ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge)
    )
      reject("INVALID_OAUTH_STATE", 400);
    const url = new URL("/i/oauth2/authorize", this.authOrigin);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.config.clientId,
      redirect_uri: this.redirectUri,
      scope: this.scopes.join(" "),
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    return url.href;
  }
  private basic() {
    return (
      "Basic " +
      Buffer.from(
        `${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(this.config.clientSecret)}`,
      ).toString("base64")
    );
  }
  private async request(
    path: string,
    init: RequestInit,
    token?: string,
    operation?: XOperation,
    mutation = false,
    empty = false,
  ) {
    if (
      operation &&
      this.mode === "live" &&
      !this.config.beforeBillableRequest
    )
      reject("INVALID_CONFIG", 503);
    await this.config.beforeRequest?.();
    if (operation) await this.config.beforeBillableRequest?.(operation);
    // A cost reservation can await storage; recheck revocation immediately before sending.
    if (operation && this.config.beforeBillableRequest)
      await this.config.beforeRequest?.();
    let response: Response;
    try {
      response = await fetch(new URL(path, this.origin), {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeout),
        headers: {
          Accept: "application/json",
          ...(token ? { Authorization: `Bearer ${text(token)}` } : {}),
          ...init.headers,
        },
      });
    } catch (error) {
      if (error instanceof SecurityError) throw error;
      throw new XError("PROVIDER_UNAVAILABLE", 502, true, mutation);
    }
    let value: unknown;
    try {
      const raw = await response.text();
      if (raw.length > 1048576) reject();
      value = raw.length ? JSON.parse(raw) : {};
    } catch {
      throw new XError("INVALID_PROVIDER_RESPONSE", 502, false, mutation);
    }
    const body = record(value),
      errors = Array.isArray(body.errors) ? body.errors.map(record) : [],
      problem = errors[0] ?? body,
      type = String(problem.type ?? ""),
      title = String(problem.title ?? ""),
      code = String(body.error ?? "");
    if (!response.ok || errors.length || code) {
      if (
        response.status === 402 ||
        /credits-depleted|usage-capped/.test(type) ||
        /^(CreditsDepleted|UsageCapExceeded)$/.test(title)
      )
        throw new XError("PROVIDER_CREDITS_REQUIRED", 402);
      if (code === "invalid_grant" || response.status === 401)
        throw new XError("RECONNECT_REQUIRED", 409);
      if (code === "invalid_scope" || /insufficient_scope/.test(type))
        throw new XError("MISSING_PERMISSION", 403);
      if (response.status === 429) {
        const after = response.headers.get("retry-after"),
          reset = response.headers.get("x-rate-limit-reset");
        const retry =
          after && /^\d+$/.test(after)
            ? Number(after) * 1000
            : reset && /^\d+$/.test(reset)
              ? Number(reset) * 1000 - this.now().getTime()
              : 60000;
        throw new XError(
          "PROVIDER_RATE_LIMITED",
          429,
          true,
          false,
          Math.max(1000, Math.min(86400000, retry)),
        );
      }
      if (response.status === 404) throw new XError("POST_NOT_FOUND", 404);
      if (response.status === 403)
        throw new XError("PROVIDER_PERMISSION_DENIED", 403);
      if (response.status >= 500)
        throw new XError("PROVIDER_UNAVAILABLE", 502, true, mutation);
      throw new XError(
        "PROVIDER_REQUEST_FAILED",
        502,
        false,
        mutation && response.ok,
      );
    }
    if (empty) return body;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new XError("INVALID_PROVIDER_RESPONSE", 502, false, mutation);
    return body;
  }
  private async token(
    body: URLSearchParams,
    expected?: string,
  ): Promise<XGrant> {
    const result = await this.request("/2/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: this.basic(),
      },
      body,
    });
    const accessToken = text(result.access_token),
      refreshToken = text(result.refresh_token);
    if (
      String(result.token_type).toLowerCase() !== "bearer" ||
      typeof result.scope !== "string" ||
      !Number.isSafeInteger(result.expires_in) ||
      Number(result.expires_in) < 1 ||
      Number(result.expires_in) > 86400
    )
      reject();
    const scopes = [...new Set(result.scope.split(/\s+/).filter(Boolean))];
    if (this.scopes.some((scope) => !scopes.includes(scope)))
      reject("MISSING_PERMISSION", 403);
    const user = await this.verifiedUser(accessToken, expected);
    return {
      providerUserId: user.id,
      name: user.name,
      username: user.username,
      accessToken,
      refreshToken,
      expiresAt: new Date(
        this.now().getTime() + Number(result.expires_in) * 1000,
      ),
      scopes,
    };
  }
  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    previous?: { providerUserId: string };
  }) {
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier))
      reject("INVALID_OAUTH_STATE", 400);
    return this.token(
      new URLSearchParams({
        grant_type: "authorization_code",
        code: text(input.code, 4096),
        redirect_uri: this.redirectUri,
        code_verifier: input.codeVerifier,
      }),
      input.previous?.providerUserId,
    );
  }
  renewVerified(input: { providerUserId: string; refreshToken: string }) {
    return this.token(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: text(input.refreshToken),
      }),
      id(input.providerUserId),
    );
  }
  async verifiedUser(accessToken: string, expected?: string) {
    const result = await this.request(
        "/2/users/me",
        { method: "GET" },
        accessToken,
        "USER_READ",
      ),
      data = record(result.data),
      userId = id(data.id);
    if (expected && userId !== expected)
      reject("PROVIDER_IDENTITY_MISMATCH", 409);
    return {
      id: userId,
      name: text(data.name, 200),
      username: text(data.username, 200),
    };
  }
  private receipt(
    result: Record<string, unknown>,
    mutation = false,
  ): XMediaReceipt {
    try {
      const data = record(result.data),
        mediaId = id(data.id),
        processing = record(data.processing_info),
        state = processing.state ?? "succeeded";
      if (
        !["pending", "in_progress", "succeeded", "failed"].includes(
          String(state),
        )
      )
        reject();
      if (
        data.expires_after_secs !== undefined &&
        (!Number.isSafeInteger(data.expires_after_secs) ||
          Number(data.expires_after_secs) < 1 ||
          Number(data.expires_after_secs) > 604800)
      )
        reject();
      if (
        data.media_key !== undefined &&
        (typeof data.media_key !== "string" ||
          !/^\d{1,3}_\d{1,19}$/.test(data.media_key))
      )
        reject();
      if (
        processing.check_after_secs !== undefined &&
        (!Number.isSafeInteger(processing.check_after_secs) ||
          Number(processing.check_after_secs) < 0 ||
          Number(processing.check_after_secs) > 86400)
      )
        reject();
      return {
        id: mediaId,
        ...(data.media_key ? { mediaKey: data.media_key as string } : {}),
        ...(data.expires_after_secs
          ? {
              expiresAt: new Date(
                this.now().getTime() + Number(data.expires_after_secs) * 1000,
              ),
            }
          : {}),
        state: state as XMediaReceipt["state"],
        checkAfterMs: Math.max(
          1000,
          Number(processing.check_after_secs ?? 1) * 1000,
        ),
      };
    } catch {
      throw new XError("INVALID_PROVIDER_RESPONSE", 502, false, mutation);
    }
  }
  async uploadImage(token: string, media: XMedia, bytes: Uint8Array) {
    validateXMedia(media, "IMAGE");
    if (bytes.byteLength !== media.bytes) reject("INVALID_MEDIA", 400);
    return this.receipt(
      await this.request(
        "/2/media/upload",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            media: Buffer.from(bytes).toString("base64"),
            media_category: "tweet_image",
          }),
        },
        token,
        "MEDIA_UPLOAD",
        true,
      ),
      true,
    );
  }
  async initVideo(token: string, media: XMedia) {
    validateXMedia(media, "SHORT_VIDEO");
    return this.receipt(
      await this.request(
        "/2/media/upload/initialize",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            media_type: media.mime,
            total_bytes: media.bytes,
            media_category: "tweet_video",
          }),
        },
        token,
        "MEDIA_INIT",
        true,
      ),
      true,
    );
  }
  async appendVideo(
    token: string,
    mediaId: string,
    segmentIndex: number,
    bytes: Uint8Array,
  ) {
    if (
      !Number.isSafeInteger(segmentIndex) ||
      segmentIndex < 0 ||
      segmentIndex > 9999 ||
      !bytes.byteLength ||
      bytes.byteLength > 5_000_000
    )
      reject("INVALID_MEDIA", 400);
    const body = new FormData();
    body.set("segment_index", String(segmentIndex));
    body.set(
      "media",
      new Blob([Uint8Array.from(bytes)], { type: "video/mp4" }),
      "chunk.mp4",
    );
    await this.request(
      `/2/media/upload/${id(mediaId)}/append`,
      { method: "POST", body },
      token,
      "MEDIA_APPEND",
      true,
      true,
    );
  }
  async finalizeVideo(token: string, mediaId: string) {
    const result = this.receipt(
      await this.request(
        `/2/media/upload/${id(mediaId)}/finalize`,
        { method: "POST" },
        token,
        "MEDIA_FINALIZE",
        true,
      ),
      true,
    );
    if (result.id !== mediaId) reject();
    return result;
  }
  async mediaStatus(token: string, mediaId: string) {
    const result = this.receipt(
      await this.request(
        `/2/media/upload?command=STATUS&media_id=${id(mediaId)}`,
        { method: "GET" },
        token,
        "MEDIA_STATUS",
      ),
    );
    if (result.id !== mediaId) reject();
    return result;
  }
  async createPost(
    token: string,
    input: {
      text: string;
      mediaIds: string[];
      madeWithAi: boolean;
      paidPartnership: boolean;
    },
  ) {
    const content = validateXText(input.text, input.mediaIds.length);
    if (
      typeof input.madeWithAi !== "boolean" ||
      typeof input.paidPartnership !== "boolean" ||
      input.mediaIds.length > 4 ||
      new Set(input.mediaIds).size !== input.mediaIds.length
    )
      reject("INVALID_CONTENT", 400);
    const result = await this.request(
      "/2/tweets",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: content.text,
          ...(input.mediaIds.length
            ? { media: { media_ids: input.mediaIds.map(id) } }
            : {}),
          made_with_ai: input.madeWithAi,
          paid_partnership: input.paidPartnership,
        }),
      },
      token,
      content.hasUrls ? "POST_CREATE_URL" : "POST_CREATE",
      true,
    );
    try {
      return { id: id(record(result.data).id) };
    } catch {
      throw new XError("INVALID_PROVIDER_RESPONSE", 502, false, true);
    }
  }
  async post(
    token: string,
    postId: string,
    expectedAuthor: string,
  ): Promise<XPost> {
    const result = await this.request(
        `/2/tweets/${id(postId)}?tweet.fields=author_id,attachments`,
        { method: "GET" },
        token,
        "POST_READ",
      ),
      data = record(result.data);
    const authorId = id(data.author_id);
    if (authorId !== id(expectedAuthor))
      reject("PROVIDER_IDENTITY_MISMATCH", 409);
    if (id(data.id) !== postId || typeof data.text !== "string") reject();
    const keys = record(data.attachments).media_keys ?? [];
    if (
      !Array.isArray(keys) ||
      keys.some((k) => typeof k !== "string" || !/^\d{1,3}_\d{1,19}$/.test(k))
    )
      reject();
    return {
      id: postId,
      authorId,
      text: data.text,
      mediaKeys: keys as string[],
    };
  }
  async deletePost(token: string, postId: string) {
    const result = await this.request(
      `/2/tweets/${id(postId)}`,
      { method: "DELETE" },
      token,
      "POST_DELETE",
      true,
    );
    if (record(result.data).deleted !== true)
      throw new XError("INVALID_PROVIDER_RESPONSE", 502, false, true);
    return { deleted: true as const };
  }
}

export const xContentDigest = (textValue: string, options: unknown) =>
  createHash("sha256")
    .update(JSON.stringify([textValue, options]))
    .digest("hex");
