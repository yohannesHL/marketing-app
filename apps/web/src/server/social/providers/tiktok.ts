import { createHash } from "node:crypto";
import { fail, SecurityError } from "../../security/errors";
import { record } from "../../providers/providerHttp";
import {
  TikTokClient,
  TikTokError,
  TIKTOK_SCOPES,
  creatorVersion,
  validateTikTokControls,
  validateTikTokMedia,
  verifiedMediaUrl,
  type TikTokConfig,
  type TikTokCreator,
  type TikTokControls,
  type TikTokPostStatus,
} from "../../providers/tiktok";
import {
  SocialProviderFailure,
  type SocialProvider,
  type SocialProviderCall,
  type SocialProviderContext,
  type SocialProgress,
  type SocialPublished,
  type SocialProviderRegistration,
  type SocialStatusResult,
} from "../types";

export type TikTokMediaConfig = {
  verifiedMediaPrefix: string;
  audited?: boolean;
  now?: () => Date;
  mediaTimeoutMs?: number;
};
type Progress = {
  provider: "tiktok";
  revisionId: string;
  mediaId: string;
  openId: string;
  creatorInfoVersion: string;
  contentDigest: string;
  privacyLevel: string;
  publishId?: string;
  failedReason?: string;
  retiredPublishIds: string[];
};
const retryableFailures = new Set(["internal", "video_pull_failed"]);
const proof = (content: SocialProviderContext["content"]) =>
  createHash("sha256")
    .update(JSON.stringify([content.body, content.providerOptions]))
    .digest("hex");
function controls(context: SocialProviderContext) {
  try {
    return validateTikTokControls(
      context.content.providerOptions as Record<string, unknown>,
      context.content.body,
    );
  } catch {
    fail(
      "INVALID_PROVIDER_OPTIONS",
      400,
      "Review explicit TikTok privacy, interaction, music, posting and disclosure choices.",
    );
  }
}
function progress(value: SocialProgress): Progress | undefined {
  if (!Object.keys(value).length) return undefined;
  if (
    value.provider !== "tiktok" ||
    typeof value.revisionId !== "string" ||
    typeof value.mediaId !== "string" ||
    typeof value.openId !== "string" ||
    typeof value.creatorInfoVersion !== "string" ||
    typeof value.contentDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.creatorInfoVersion) ||
    !/^[a-f0-9]{64}$/.test(value.contentDigest) ||
    typeof value.privacyLevel !== "string" ||
    !Array.isArray(value.retiredPublishIds) ||
    value.retiredPublishIds.length > 10 ||
    value.retiredPublishIds.some(
      (id) => typeof id !== "string" || !/^[-A-Za-z0-9_.~]{1,64}$/.test(id),
    ) ||
    (value.publishId !== undefined &&
      (typeof value.publishId !== "string" ||
        !/^[-A-Za-z0-9_.~]{1,64}$/.test(value.publishId))) ||
    (value.failedReason !== undefined &&
      (typeof value.failedReason !== "string" ||
        !/^[a-z0-9_]{1,100}$/.test(value.failedReason))) ||
    Object.keys(value).some(
      (key) =>
        ![
          "provider",
          "revisionId",
          "mediaId",
          "openId",
          "creatorInfoVersion",
          "contentDigest",
          "privacyLevel",
          "publishId",
          "failedReason",
          "retiredPublishIds",
        ].includes(key),
    )
  )
    fail(
      "INVALID_PROVIDER_PROGRESS",
      502,
      "The saved TikTok publication evidence is unavailable.",
    );
  return {
    ...value,
    retiredPublishIds: [...value.retiredPublishIds],
  } as Progress;
}
/** PULL_FROM_URL sends only a reviewed, owned signed URL; no native scheduler or deletion. */
export class TikTokSocialProvider implements SocialProvider {
  private readonly now: () => Date;
  private readonly mode: "mock" | "live";
  constructor(
    private readonly config: TikTokConfig,
    private readonly mediaConfig: TikTokMediaConfig,
  ) {
    const client = new TikTokClient({
      ...config,
      verifiedMediaPrefix: mediaConfig.verifiedMediaPrefix,
    });
    this.mode = client.mode;
    this.now = mediaConfig.now ?? config.now ?? (() => new Date());
    let placeholder: URL;
    try {
      placeholder = new URL(mediaConfig.verifiedMediaPrefix);
    } catch {
      fail("INVALID_CONFIG", 503, "Configure the owned TikTok media prefix.");
    }
    placeholder.pathname += "configuration-check";
    placeholder.search = new URLSearchParams({
      expires: String(Math.ceil((this.now().getTime() + 7200000) / 1000)),
      signature: "a".repeat(64),
    }).toString();
    verifiedMediaUrl(
      placeholder.href,
      mediaConfig.verifiedMediaPrefix,
      this.mode,
      this.now(),
    );
    if (
      (mediaConfig.audited !== undefined &&
        typeof mediaConfig.audited !== "boolean") ||
      (mediaConfig.mediaTimeoutMs !== undefined &&
        (!Number.isSafeInteger(mediaConfig.mediaTimeoutMs) ||
          mediaConfig.mediaTimeoutMs < 1 ||
          mediaConfig.mediaTimeoutMs > 60000))
    )
      fail(
        "INVALID_CONFIG",
        503,
        "Configure supported TikTok media download settings.",
      );
  }
  private client(call: SocialProviderCall) {
    if (call.mode !== this.mode)
      fail(
        "CONNECTION_MODE_MISMATCH",
        409,
        "Choose a TikTok connection for this provider mode.",
      );
    if (call.destination.kind !== "TIKTOK_PROFILE")
      fail(
        "UNSUPPORTED_CONTENT",
        400,
        "Choose a verified TikTok creator profile.",
      );
    return new TikTokClient({
      ...this.config,
      verifiedMediaPrefix: this.mediaConfig.verifiedMediaPrefix,
      beforeRequest: call.verifyCurrent,
    });
  }
  private binding(
    context: SocialProviderContext,
    call: SocialProviderCall,
    saved?: Progress,
  ) {
    this.client(call);
    if (
      !call.providerUserId ||
      call.providerUserId !== call.destination.externalId
    )
      fail(
        "INVALID_SELECTION",
        409,
        "Choose the profile belonging to the verified TikTok identity.",
      );
    const options = controls(context);
    if (context.content.format !== "SHORT_VIDEO" || call.media.length !== 1)
      fail(
        "UNSUPPORTED_CONTENT",
        400,
        "TikTok Direct Post requires one reviewed video.",
      );
    const asset = call.media[0];
    if (
      saved &&
      (saved.revisionId !== context.revisionId ||
        saved.mediaId !== asset.id ||
        saved.openId !== call.destination.externalId ||
        saved.creatorInfoVersion !== options.creatorInfoVersion ||
        saved.contentDigest !== proof(context.content) ||
        saved.privacyLevel !== options.privacyLevel)
    )
      fail(
        "INVALID_PROVIDER_PROGRESS",
        502,
        "This TikTok progress does not belong to the reviewed creator and content.",
      );
    return { options, asset };
  }
  private async eligibility(
    context: SocialProviderContext,
    call: SocialProviderCall,
    saved?: Progress,
  ) {
    const bound = this.binding(context, call, saved),
      stored = record(record(call.destination.metadata).tiktokCreator);
    if (
      !call.authorizationId ||
      stored.authorizationId !== call.authorizationId ||
      !Number.isSafeInteger(stored.authorizationGeneration) ||
      Number(stored.authorizationGeneration) < 1 ||
      stored.authorizationGeneration !== call.authorizationGeneration ||
      typeof stored.checkedAt !== "string" ||
      !Number.isFinite(Date.parse(stored.checkedAt)) ||
      Date.parse(stored.checkedAt) > this.now().getTime() ||
      stored.openId !== call.destination.externalId ||
      stored.version !== bound.options.creatorInfoVersion
    )
      fail(
        "REVIEW_REQUIRED",
        409,
        "Refresh trusted TikTok creator settings and review this version before publishing.",
      );
    const creator = await this.classified(() =>
      this.client(call).creatorInfo(
        call.accessToken,
        call.destination.externalId,
      ),
    );
    if (creator.version !== bound.options.creatorInfoVersion)
      fail(
        "INVALID_PROVIDER_OPTIONS",
        409,
        "TikTok creator settings changed. Refresh and review privacy, interactions and eligibility again.",
      );
    this.verifyCreator(creator, bound.options);
    try {
      validateTikTokMedia(bound.asset, creator.maxDurationSeconds);
    } catch {
      fail(
        "UNSUPPORTED_CONTENT",
        400,
        "Choose video matching TikTok's verified size, duration, codec and frame-rate limits.",
      );
    }
    return bound;
  }
  private verifyCreator(creator: TikTokCreator, options: TikTokControls) {
    if (
      creatorVersion(creator) !== creator.version ||
      !creator.privacyLevels.includes(options.privacyLevel) ||
      (creator.commentDisabled && !options.disableComment) ||
      (creator.duetDisabled && !options.disableDuet) ||
      (creator.stitchDisabled && !options.disableStitch)
    )
      fail(
        "INVALID_PROVIDER_OPTIONS",
        409,
        "Choose privacy and interactions permitted by the current TikTok creator settings.",
      );
    if (
      !this.mediaConfig.audited &&
      (options.privacyLevel !== "SELF_ONLY" ||
        creator.privacyLevels.includes("PUBLIC_TO_EVERYONE") ||
        !creator.privacyLevels.includes("FOLLOWER_OF_CREATOR"))
    )
      fail(
        "INVALID_PROVIDER_OPTIONS",
        403,
        "Unaudited TikTok apps require a private creator account and SELF_ONLY visibility.",
      );
  }
  private async classified<T>(
    work: () => Promise<T>,
    uncertain = false,
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof TikTokError)) throw error;
      if (
        [
          "RECONNECT_REQUIRED",
          "MISSING_PERMISSION",
          "PROVIDER_IDENTITY_MISMATCH",
          "CREATOR_SETTINGS_CHANGED",
          "UNAUDITED_RESTRICTION",
        ].includes(error.code)
      )
        throw error;
      if (uncertain || error.outcomeUnknown)
        throw new SocialProviderFailure("TRANSIENT", false, error.retryAfterMs);
      if (error.code === "PROVIDER_RATE_LIMITED")
        throw new SocialProviderFailure("RATE_LIMIT", true, error.retryAfterMs);
      if (error.retryable)
        throw new SocialProviderFailure("TRANSIENT", true, error.retryAfterMs);
      throw new SocialProviderFailure("TERMINAL", true);
    }
  }
  async validate(context: SocialProviderContext) {
    await context.rpc("PREPARE", (call) => this.eligibility(context, call));
  }
  async prepare(
    context: SocialProviderContext,
    value: SocialProgress,
  ): Promise<SocialProgress> {
    const saved = progress(value);
    return context.rpc("PREPARE", async (call) => {
      const { options, asset } = await this.eligibility(context, call, saved);
      if (saved?.failedReason) {
        if (!retryableFailures.has(saved.failedReason))
          throw new SocialProviderFailure("TERMINAL", true);
        if (!saved.publishId)
          fail(
            "INVALID_PROVIDER_PROGRESS",
            502,
            "The prior failed TikTok request has no identity.",
          );
        saved.retiredPublishIds.push(saved.publishId);
        delete saved.publishId;
        delete saved.failedReason;
      }
      if (!saved?.publishId) await this.mediaHead(call, asset);
      return (
        saved ?? {
          provider: "tiktok",
          revisionId: context.revisionId,
          mediaId: asset.id,
          openId: call.destination.externalId,
          creatorInfoVersion: options.creatorInfoVersion,
          contentDigest: proof(context.content),
          privacyLevel: options.privacyLevel,
          retiredPublishIds: [],
        }
      );
    });
  }
  async publish(
    context: SocialProviderContext,
    value: SocialProgress,
  ): Promise<SocialPublished> {
    const saved = progress(value);
    if (!saved)
      fail(
        "INVALID_PROVIDER_PROGRESS",
        502,
        "Prepare the reviewed TikTok video before sending it.",
      );
    if (!saved.publishId) {
      // All fresh reads and URL checks happen before the sole mutating submission boundary.
      await context.rpc("PREPARE", async (call) => {
        const { asset } = await this.eligibility(context, call, saved);
        await this.mediaHead(call, asset);
      });
      const receipt = await context.rpc("PUBLISH", async (call) => {
        const { options, asset } = this.binding(context, call, saved);
        verifiedMediaUrl(
          asset.url,
          this.mediaConfig.verifiedMediaPrefix,
          this.mode,
          new Date(this.now().getTime() + 3600000),
        );
        return this.classified(() =>
          this.client(call).initVideo(call.accessToken, {
            caption: context.content.body,
            controls: options,
            videoUrl: asset.url,
          }),
        );
      });
      saved.publishId = receipt.publishId;
      await context.checkpoint({ ...saved });
    }
    const result = await context.rpc("PROCESS", async (call) => {
      this.binding(context, call, saved);
      return this.classified(
        () => this.client(call).postStatus(call.accessToken, saved.publishId!),
        true,
      );
    });
    const confirmed = this.confirmed(result, saved);
    if (confirmed) return confirmed;
    if (result.status === "FAILED") {
      saved.failedReason = result.failReason;
      await context.checkpoint({ ...saved });
    }
    throw new SocialProviderFailure("TRANSIENT", false);
  }
  async status(
    context: SocialProviderContext,
    value: SocialProgress,
  ): Promise<SocialStatusResult> {
    const saved = progress(value);
    if (!saved?.publishId) return { status: "UNKNOWN" };
    return context.rpc("PROCESS", async (call) => {
      this.binding(context, call, saved);
      await this.classified(
        () => this.client(call).verifiedUser(call.accessToken, saved.openId),
        true,
      );
      const result = await this.classified(
        () => this.client(call).postStatus(call.accessToken, saved.publishId!),
        true,
      );
      const confirmed = this.confirmed(result, saved);
      if (confirmed) return { status: "PUBLISHED", result: confirmed };
      if (result.status === "FAILED") {
        saved.failedReason = result.failReason;
        await context.checkpoint({ ...saved });
        return { status: "NOT_PUBLISHED" };
      }
      return {
        status: result.status === "SEND_TO_USER_INBOX" ? "UNKNOWN" : "PENDING",
      };
    });
  }
  private confirmed(
    result: TikTokPostStatus,
    saved: Progress,
  ): SocialPublished | undefined {
    if (result.status !== "PUBLISH_COMPLETE") return;
    if (saved.privacyLevel === "SELF_ONLY")
      return { externalId: result.publicPostIds[0] ?? saved.publishId! };
    // Public moderation can finish after PUBLISH_COMPLETE; never invent a public post link.
    if (
      saved.privacyLevel === "PUBLIC_TO_EVERYONE" &&
      !result.publicPostIds.length
    )
      return;
    return { externalId: result.publicPostIds[0] ?? saved.publishId! };
  }
  async cancel(context: SocialProviderContext, value: SocialProgress) {
    const saved = progress(value);
    if (!saved?.publishId) return { cancelled: false };
    return context.rpc("PROCESS", async (call) => {
      this.binding(context, call, saved);
      const result = await this.classified(
        () => this.client(call).postStatus(call.accessToken, saved.publishId!),
        true,
      );
      if (result.status !== "PROCESSING_DOWNLOAD")
        return {
          cancelled:
            result.status === "FAILED" &&
            result.failReason === "publish_cancelled",
        };
      try {
        await this.client(call).cancelDownload(
          call.accessToken,
          saved.publishId!,
        );
      } catch (error) {
        if (
          error instanceof TikTokError &&
          error.code === "PUBLISH_NOT_CANCELLABLE"
        )
          return { cancelled: false };
        throw error;
      }
      const readback = await this.classified(
        () => this.client(call).postStatus(call.accessToken, saved.publishId!),
        true,
      );
      return {
        cancelled:
          readback.status === "FAILED" &&
          readback.failReason === "publish_cancelled",
      };
    });
  }
  private async mediaHead(
    call: SocialProviderCall,
    asset: SocialProviderCall["media"][number],
  ) {
    const url = verifiedMediaUrl(
      asset.url,
      this.mediaConfig.verifiedMediaPrefix,
      this.mode,
      new Date(this.now().getTime() + 3600000),
    );
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(asset.id) ||
      !url.pathname.endsWith(`/${asset.id}/content`)
    )
      fail(
        "MEDIA_UNAVAILABLE",
        409,
        "Choose the owned signed video URL for this asset.",
      );
    await call.verifyCurrent();
    let response: Response;
    try {
      response = await fetch(url, {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(this.mediaConfig.mediaTimeoutMs ?? 20000),
      });
    } catch {
      throw new SocialProviderFailure("TRANSIENT", true);
    }
    if (
      response.status !== 200 ||
      response.headers.get("content-type")?.split(";")[0] !== asset.mime ||
      response.headers.get("content-length") !== String(asset.bytes)
    ) {
      await response.body?.cancel();
      fail(
        "MEDIA_UNAVAILABLE",
        409,
        "The reviewed video URL changed, redirected or expired.",
      );
    }
  }
}
export function tiktokSocialRegistration(
  config: TikTokConfig,
  media: TikTokMediaConfig,
): SocialProviderRegistration {
  return {
    platform: "TIKTOK",
    kind: "TIKTOK_PROFILE",
    modes: [config.mockoonBaseUrl ? "mock" : "live"],
    requiredScopes: [...TIKTOK_SCOPES],
    formats: ["SHORT_VIDEO"],
    mediaFetchWindowMs: 3600000,
    validateContent: (content, assets) => {
      try {
        validateTikTokControls(
          content.providerOptions as Record<string, unknown>,
          content.body,
        );
        if (content.format !== "SHORT_VIDEO" || assets.length !== 1)
          throw new Error();
        validateTikTokMedia(assets[0]);
      } catch {
        fail(
          "INVALID_PROVIDER_OPTIONS",
          400,
          "Review TikTok posting controls and one supported inspected video.",
        );
      }
    },
    factory: () => new TikTokSocialProvider(config, media),
  };
}
