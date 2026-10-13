import { createHash } from "node:crypto";
import { SecurityError } from "../security/errors";
import { mockoonOrigin, record } from "./providerHttp";

export const TIKTOK_SCOPES = ["user.info.basic", "video.publish"] as const;
export type TikTokConfig = {
  clientKey: string;
  clientSecret: string;
  redirectUri: string;
  mockoonBaseUrl?: string;
  mockoonEnabled?: boolean;
  requestTimeoutMs?: number;
  verifiedMediaPrefix?: string;
  now?: () => Date;
  beforeRequest?: () => Promise<void>;
};
export type TikTokGrant = {
  providerUserId: string;
  accessToken: string;
  refreshToken: string;
  scopes: string[];
  expiresAt: Date;
  refreshExpiresAt: Date;
  name: string;
};
export type TikTokCreator = {
  openId: string;
  username: string;
  nickname: string;
  privacyLevels: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxDurationSeconds: number;
  version: string;
};
export type TikTokVideo = {
  mime: string;
  bytes: number;
  width: number;
  height: number;
  durationMs: number | null;
  metadata?: unknown;
};
export type TikTokControls = {
  privacyLevel: string;
  disableComment: boolean;
  disableDuet: boolean;
  disableStitch: boolean;
  commercialContentDisclosure: boolean;
  brandContentToggle: boolean;
  brandOrganicToggle: boolean;
  musicUsageConsent: boolean;
  explicitPostingConsent: boolean;
  isAigc: boolean;
  creatorInfoVersion: string;
};
export type TikTokPostStatus = {
  status:
    | "PROCESSING_DOWNLOAD"
    | "PROCESSING_UPLOAD"
    | "SEND_TO_USER_INBOX"
    | "PUBLISH_COMPLETE"
    | "FAILED";
  publicPostIds: string[];
  failReason?: string;
};
const levels = [
  "PUBLIC_TO_EVERYONE",
  "MUTUAL_FOLLOW_FRIENDS",
  "FOLLOWER_OF_CREATOR",
  "SELF_ONLY",
];
const limits = new Map<string, { start: number; count: number }>();
const help: Record<string, string> = {
  INVALID_CONFIG: "TikTok is not configured for this environment.",
  RECONNECT_REQUIRED: "Reconnect TikTok and approve access again.",
  MISSING_PERMISSION: "Approve TikTok profile and direct-post permissions.",
  CONSENT_DENIED: "TikTok permission was declined.",
  PROVIDER_IDENTITY_MISMATCH: "Reconnect with the original TikTok identity.",
  PROVIDER_RATE_LIMITED: "TikTok request limits were reached. Try again later.",
  CREATOR_UNAVAILABLE:
    "This creator cannot publish right now. Try again later.",
  CREATOR_SETTINGS_CHANGED:
    "TikTok creator settings changed. Refresh and review them again.",
  UNAUDITED_RESTRICTION:
    "Unaudited TikTok apps require a private creator account and SELF_ONLY visibility.",
  INVALID_POST_CONTROLS:
    "Review TikTok privacy, interactions, disclosures, and explicit posting consent.",
  INVALID_MEDIA: "Choose verified video meeting TikTok's media requirements.",
  MEDIA_UNAVAILABLE:
    "The verified media URL is unavailable or expires too soon.",
  PUBLISH_NOT_CANCELLABLE: "This download can no longer be cancelled.",
  PUBLISH_ID_NOT_FOUND: "TikTok could not verify this publication request.",
  PROVIDER_PERMISSION_DENIED: "TikTok did not allow this publication request.",
  INVALID_PROVIDER_RESPONSE: "TikTok returned an incomplete response.",
  PROVIDER_UNAVAILABLE: "TikTok could not be reached. Try again later.",
};
export class TikTokError extends SecurityError {
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
      help[code] ?? "TikTok could not complete this request.",
    );
  }
}
function reject(code = "INVALID_PROVIDER_RESPONSE", status = 502): never {
  throw new TikTokError(code, status);
}
function text(value: unknown, max = 32768) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    return reject();
  return value;
}
function identity(value: unknown, max = 128) {
  const result = text(value, max);
  if (!/^[A-Za-z0-9_.~-]+$/.test(result)) return reject();
  return result;
}
function ttl(value: unknown) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 366 * 86400
  )
    return reject();
  return value;
}
export function creatorVersion(value: Omit<TikTokCreator, "version">) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        value.openId,
        value.username,
        value.nickname,
        [...value.privacyLevels].sort(),
        value.commentDisabled,
        value.duetDisabled,
        value.stitchDisabled,
        value.maxDurationSeconds,
      ]),
    )
    .digest("hex");
}
export function validateTikTokMedia(
  media: TikTokVideo,
  maxDurationSeconds = 600,
) {
  const metadata = record(media?.metadata);
  if (
    !media ||
    !["video/mp4", "video/webm", "video/quicktime"].includes(media.mime) ||
    !Number.isSafeInteger(media.bytes) ||
    media.bytes < 1 ||
    media.bytes > 4_000_000_000 ||
    !Number.isSafeInteger(media.width) ||
    !Number.isSafeInteger(media.height) ||
    media.width < 360 ||
    media.height < 360 ||
    media.width > 4096 ||
    media.height > 4096 ||
    !Number.isFinite(media.durationMs) ||
    Number(media.durationMs) <= 0 ||
    Number(media.durationMs) > Math.min(600, maxDurationSeconds) * 1000 ||
    !["h264", "hevc", "vp8", "vp9"].includes(String(metadata.videoCodec)) ||
    typeof metadata.fps !== "number" ||
    metadata.fps < 23 ||
    metadata.fps > 60 ||
    !Number.isFinite(metadata.fps)
  )
    reject("INVALID_MEDIA", 400);
  return media;
}
export function validateTikTokControls(
  options: Record<string, unknown>,
  caption: string,
): TikTokControls {
  const booleanKeys = [
    "disableComment",
    "disableDuet",
    "disableStitch",
    "commercialContentDisclosure",
    "brandContentToggle",
    "brandOrganicToggle",
    "musicUsageConsent",
    "explicitPostingConsent",
    "isAigc",
  ];
  if (
    typeof caption !== "string" ||
    caption.length > 2200 ||
    !levels.includes(String(options.privacyLevel)) ||
    typeof options.creatorInfoVersion !== "string" ||
    !/^[a-f0-9]{64}$/.test(options.creatorInfoVersion) ||
    booleanKeys.some((key) => typeof options[key] !== "boolean") ||
    options.musicUsageConsent !== true ||
    options.explicitPostingConsent !== true ||
    (options.commercialContentDisclosure === true
      ? options.brandContentToggle !== true &&
        options.brandOrganicToggle !== true
      : options.brandContentToggle === true ||
        options.brandOrganicToggle === true) ||
    (options.brandContentToggle === true &&
      options.privacyLevel === "SELF_ONLY")
  )
    reject("INVALID_POST_CONTROLS", 400);
  return { ...options } as TikTokControls;
}
/** Preserve exact int64 post IDs before JSON's floating-point conversion. */
function losslessJson(raw: string): unknown {
  if (raw.length > 1048576) reject();
  let output = "",
    quoted = false;
  for (let i = 0; i < raw.length; ) {
    const ch = raw[i];
    if (quoted) {
      output += ch;
      i++;
      if (ch === "\\" && i < raw.length) output += raw[i++];
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      output += ch;
      i++;
      continue;
    }
    const number = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(raw.slice(i));
    if (number) {
      const token = number[0];
      output +=
        /^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token))
          ? JSON.stringify(token)
          : token;
      i += token.length;
    } else {
      output += ch;
      i++;
    }
  }
  return JSON.parse(output);
}
export function verifiedMediaUrl(
  value: string,
  prefix: string | undefined,
  mode: "mock" | "live",
  minimumValidUntil: Date,
) {
  let url: URL, base: URL;
  try {
    base = new URL(prefix ?? "");
  } catch {
    return reject("INVALID_CONFIG", 503);
  }
  try {
    url = new URL(value);
  } catch {
    return reject("MEDIA_UNAVAILABLE", 409);
  }
  const mock =
    mode === "mock" &&
    base.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !base.pathname.endsWith("/") ||
    !(base.protocol === "https:" || mock) ||
    (!mock &&
      (/^(?:\d+\.){3}\d+$/.test(base.hostname) ||
        base.hostname.startsWith("[")))
  )
    reject("INVALID_CONFIG", 503);
  if (
    url.origin !== base.origin ||
    url.username ||
    url.password ||
    url.hash ||
    !url.pathname.startsWith(base.pathname) ||
    /%|\\/.test(url.pathname) ||
    !/^\d{10}$/.test(url.searchParams.get("expires") ?? "") ||
    url.searchParams.getAll("expires").length !== 1 ||
    url.searchParams.getAll("signature").length !== 1 ||
    [...url.searchParams.keys()].length !== 2 ||
    !/^[a-f0-9]{64}$/.test(url.searchParams.get("signature") ?? "") ||
    Number(url.searchParams.get("expires")) * 1000 < minimumValidUntil.getTime()
  )
    reject("MEDIA_UNAVAILABLE", 409);
  return url;
}
/** Static provider hosts; caller URLs can never select an API endpoint. */
export class TikTokClient {
  readonly scopes = [...TIKTOK_SCOPES];
  readonly pkce = false;
  readonly redirectUri: string;
  readonly mode: "mock" | "live";
  private readonly origin: string;
  private readonly authOrigin: string;
  private readonly now: () => Date;
  private readonly timeout: number;
  constructor(private readonly config: TikTokConfig) {
    if (
      !config.clientKey ||
      config.clientKey.length > 512 ||
      !config.clientSecret ||
      config.clientSecret.length > 32768 ||
      /[\r\n]/.test(config.clientKey + config.clientSecret) ||
      (config.mockoonBaseUrl && config.mockoonEnabled !== true) ||
      (config.mockoonEnabled === true && !config.mockoonBaseUrl)
    )
      reject("INVALID_CONFIG", 503);
    const mock = mockoonOrigin(config.mockoonBaseUrl);
    this.mode = mock ? "mock" : "live";
    this.origin = mock ?? "https://open.tiktokapis.com";
    this.authOrigin = mock ?? "https://www.tiktok.com";
    let uri: URL;
    try {
      uri = new URL(config.redirectUri);
    } catch {
      reject("INVALID_CONFIG", 503);
    }
    if (
      uri.username ||
      uri.password ||
      uri.search ||
      uri.hash ||
      uri.href.length >= 512 ||
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
  authorizationUrl({ state }: { state: string }) {
    if (!/^[A-Za-z0-9_-]{16,1024}$/.test(state))
      reject("INVALID_OAUTH_STATE", 400);
    const url = new URL("/v2/auth/authorize/", this.authOrigin);
    url.search = new URLSearchParams({
      client_key: this.config.clientKey,
      response_type: "code",
      scope: this.scopes.join(","),
      redirect_uri: this.redirectUri,
      state,
      disable_auto_auth: "1",
    }).toString();
    return url.href;
  }
  private quota(path: string, token?: string) {
    const cap = path.includes("creator_info")
      ? 20
      : path.includes("video/init")
        ? 6
        : path.includes("status/fetch")
          ? 30
          : undefined;
    if (!cap || !token) return;
    const now = this.now().getTime(),
      key = createHash("sha256")
        .update(token + ":" + path)
        .digest("hex"),
      bucket = limits.get(key);
    if (limits.size > 10000)
      for (const [k, v] of limits) if (now - v.start >= 60000) limits.delete(k);
    if (bucket && now - bucket.start < 60000) {
      if (bucket.count >= cap)
        throw new TikTokError(
          "PROVIDER_RATE_LIMITED",
          429,
          true,
          false,
          60000 - (now - bucket.start),
        );
      bucket.count++;
    } else limits.set(key, { start: now, count: 1 });
  }
  private async request(
    path: string,
    init: RequestInit = {},
    token?: string,
    submission = false,
  ) {
    await this.config.beforeRequest?.();
    this.quota(path, token);
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
      throw new TikTokError("PROVIDER_UNAVAILABLE", 502, true, submission);
    }
    let value: unknown;
    try {
      value = losslessJson(await response.text());
    } catch {
      throw new TikTokError(
        "INVALID_PROVIDER_RESPONSE",
        502,
        false,
        submission,
      );
    }
    const body = record(value),
      nested = record(body.error),
      code = typeof body.error === "string" ? body.error : nested.code;
    if (!response.ok || (code !== undefined && code !== "ok")) {
      const name = typeof code === "string" ? code : "";
      if (["scope_not_authorized", "invalid_scope"].includes(name))
        throw new TikTokError("MISSING_PERMISSION", 403);
      if (
        ["invalid_grant", "access_token_invalid", "invalid_token"].includes(
          name,
        ) ||
        response.status === 401
      )
        throw new TikTokError("RECONNECT_REQUIRED", 409);
      if (name === "access_denied")
        throw new TikTokError("CONSENT_DENIED", 400);
      if (name === "rate_limit_exceeded" || response.status === 429) {
        const raw = response.headers.get("retry-after"),
          delay =
            raw && /^\d+$/.test(raw)
              ? Math.min(86400000, Number(raw) * 1000)
              : undefined;
        throw new TikTokError("PROVIDER_RATE_LIMITED", 429, true, false, delay);
      }
      if (name === "unaudited_client_can_only_post_to_private_accounts")
        throw new TikTokError("UNAUDITED_RESTRICTION", 403);
      if (
        [
          "spam_risk_too_many_posts",
          "spam_risk_user_banned_from_posting",
          "reached_active_user_cap",
        ].includes(name)
      )
        throw new TikTokError("CREATOR_UNAVAILABLE", 409);
      if (name === "privacy_level_option_mismatch")
        throw new TikTokError("CREATOR_SETTINGS_CHANGED", 409);
      if (name === "publish_not_cancellable")
        throw new TikTokError("PUBLISH_NOT_CANCELLABLE", 409);
      if (name === "invalid_publish_id")
        throw new TikTokError("PUBLISH_ID_NOT_FOUND", 404);
      if (
        name === "token_not_authorized_for_specified_publish_id" ||
        name === "url_ownership_unverified" ||
        response.status === 403
      )
        throw new TikTokError("PROVIDER_PERMISSION_DENIED", 403);
      if (response.status >= 500 || name === "internal_error")
        throw new TikTokError("PROVIDER_UNAVAILABLE", 502, true, submission);
      throw new TikTokError(
        "PROVIDER_REQUEST_FAILED",
        502,
        false,
        submission && !code,
      );
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new TikTokError(
        "INVALID_PROVIDER_RESPONSE",
        502,
        false,
        submission,
      );
    if (path !== "/v2/oauth/token/" && code !== "ok")
      throw new TikTokError(
        "INVALID_PROVIDER_RESPONSE",
        502,
        false,
        submission,
      );
    return body;
  }
  private async token(
    body: URLSearchParams,
    expected?: string,
  ): Promise<TikTokGrant> {
    const result = await this.request("/v2/oauth/token/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const openId = identity(result.open_id),
      accessToken = text(result.access_token),
      refreshToken = text(result.refresh_token),
      seconds = ttl(result.expires_in),
      refreshSeconds = ttl(result.refresh_expires_in);
    if (result.token_type !== "Bearer" || typeof result.scope !== "string")
      reject();
    const scopes = [
      ...new Set(
        result.scope
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ];
    if (this.scopes.some((scope) => !scopes.includes(scope)))
      reject("MISSING_PERMISSION", 403);
    if (expected && openId !== expected)
      reject("PROVIDER_IDENTITY_MISMATCH", 409);
    const user = await this.verifiedUser(accessToken, openId);
    return {
      providerUserId: openId,
      accessToken,
      refreshToken,
      scopes,
      expiresAt: new Date(this.now().getTime() + seconds * 1000),
      refreshExpiresAt: new Date(this.now().getTime() + refreshSeconds * 1000),
      name: user.name,
    };
  }
  exchangeCode(input: { code: string; previous?: { providerUserId: string } }) {
    return this.token(
      new URLSearchParams({
        client_key: this.config.clientKey,
        client_secret: this.config.clientSecret,
        grant_type: "authorization_code",
        code: text(input.code, 4096),
        redirect_uri: this.redirectUri,
      }),
      input.previous?.providerUserId,
    );
  }
  renewVerified(input: { providerUserId: string; refreshToken: string }) {
    return this.token(
      new URLSearchParams({
        client_key: this.config.clientKey,
        client_secret: this.config.clientSecret,
        grant_type: "refresh_token",
        refresh_token: text(input.refreshToken),
      }),
      identity(input.providerUserId),
    );
  }
  async verifiedUser(accessToken: string, expectedOpenId?: string) {
    const result = await this.request(
        "/v2/user/info/?fields=open_id,display_name",
        { method: "GET" },
        accessToken,
      ),
      user = record(record(result.data).user),
      openId = identity(user.open_id);
    if (expectedOpenId && openId !== expectedOpenId)
      reject("PROVIDER_IDENTITY_MISMATCH", 409);
    return {
      openId,
      name:
        typeof user.display_name === "string" &&
        user.display_name.length <= 200 &&
        !/[\u0000-\u001f\u007f]/.test(user.display_name)
          ? user.display_name
          : openId,
    };
  }
  async creatorInfo(
    accessToken: string,
    expectedOpenId: string,
  ): Promise<TikTokCreator> {
    const user = await this.verifiedUser(accessToken, expectedOpenId),
      result = await this.request(
        "/v2/post/publish/creator_info/query/",
        {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=UTF-8" },
          body: "{}",
        },
        accessToken,
      ),
      data = record(result.data);
    if (
      !Array.isArray(data.privacy_level_options) ||
      !data.privacy_level_options.length ||
      data.privacy_level_options.some((v) => !levels.includes(String(v))) ||
      new Set(data.privacy_level_options).size !==
        data.privacy_level_options.length ||
      [data.comment_disabled, data.duet_disabled, data.stitch_disabled].some(
        (v) => typeof v !== "boolean",
      ) ||
      !Number.isSafeInteger(data.max_video_post_duration_sec) ||
      Number(data.max_video_post_duration_sec) < 1 ||
      Number(data.max_video_post_duration_sec) > 3600
    )
      reject();
    const snapshot = {
      openId: user.openId,
      username: text(data.creator_username, 200),
      nickname: text(data.creator_nickname, 200),
      privacyLevels: [...(data.privacy_level_options as string[])].sort(),
      commentDisabled: data.comment_disabled as boolean,
      duetDisabled: data.duet_disabled as boolean,
      stitchDisabled: data.stitch_disabled as boolean,
      maxDurationSeconds: Number(data.max_video_post_duration_sec),
    };
    return { ...snapshot, version: creatorVersion(snapshot) };
  }
  async initVideo(
    accessToken: string,
    input: { caption: string; controls: TikTokControls; videoUrl: string },
  ) {
    validateTikTokControls(input.controls, input.caption);
    verifiedMediaUrl(
      input.videoUrl,
      this.config.verifiedMediaPrefix,
      this.mode,
      new Date(this.now().getTime() + 3600000),
    );
    const o = input.controls;
    const body = {
      post_info: {
        title: input.caption,
        privacy_level: o.privacyLevel,
        disable_comment: o.disableComment,
        disable_duet: o.disableDuet,
        disable_stitch: o.disableStitch,
        brand_content_toggle: o.brandContentToggle,
        brand_organic_toggle: o.brandOrganicToggle,
        is_aigc: o.isAigc,
      },
      source_info: { source: "PULL_FROM_URL", video_url: input.videoUrl },
    };
    const result = await this.request(
      "/v2/post/publish/video/init/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify(body),
      },
      accessToken,
      true,
    );
    try {
      return { publishId: identity(record(result.data).publish_id, 64) };
    } catch {
      throw new TikTokError("INVALID_PROVIDER_RESPONSE", 502, false, true);
    }
  }
  async postStatus(
    accessToken: string,
    publishId: string,
  ): Promise<TikTokPostStatus> {
    const result = await this.request(
        "/v2/post/publish/status/fetch/",
        {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=UTF-8" },
          body: JSON.stringify({ publish_id: identity(publishId, 64) }),
        },
        accessToken,
      ),
      data = record(result.data),
      status = data.status;
    if (
      ![
        "PROCESSING_DOWNLOAD",
        "PROCESSING_UPLOAD",
        "SEND_TO_USER_INBOX",
        "PUBLISH_COMPLETE",
        "FAILED",
      ].includes(String(status))
    )
      reject();
    const ids = data.publicaly_available_post_id ?? [];
    if (
      !Array.isArray(ids) ||
      ids.some(
        (id) =>
          (typeof id !== "string" &&
            !(typeof id === "number" && Number.isSafeInteger(id))) ||
          !/^\d{1,24}$/.test(String(id)),
      )
    )
      reject();
    if (
      status === "FAILED" &&
      (typeof data.fail_reason !== "string" ||
        !/^[a-z0-9_]{1,100}$/.test(data.fail_reason))
    )
      reject();
    return {
      status: status as TikTokPostStatus["status"],
      publicPostIds: [...new Set(ids.map(String))],
      ...(status === "FAILED"
        ? { failReason: data.fail_reason as string }
        : {}),
    };
  }
  async cancelDownload(accessToken: string, publishId: string) {
    await this.request(
      "/v2/post/publish/cancel/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ publish_id: identity(publishId, 64) }),
      },
      accessToken,
    );
    return { accepted: true as const };
  }
}
