import type { SocialMediaAsset } from "../../../generated/prisma/client";
import { YouTubeClient, YouTubeError, YOUTUBE_CHUNK_BYTES, YOUTUBE_SCOPES, validateShortsMedia,
  type YouTubeConfig, type YouTubeUploadInput, type YouTubeVideoStatus } from "../../providers/youtube";
import { fail, SecurityError } from "../../security/errors";
import { SocialProviderFailure, type SocialProgress, type SocialProvider, type SocialProviderCall,
  type SocialProviderContext, type SocialProviderRegistration, type SocialPublished, type SocialStatusResult } from "../types";

type MediaConfig = { mediaOrigin: string; maxBytes?: number; mediaTimeoutMs?: number };
type Progress = SocialProgress & { provider: "youtube"; revisionId: string; mediaId: string; channelId: string;
  totalBytes: number; mimeType: string; privacyStatus: YouTubeUploadInput["privacyStatus"]; offset: number;
  sessionUrl?: string; videoId?: string };

function controls(content: SocialProviderContext["content"]) {
  const options = content.providerOptions;
  if (content.format !== "SHORT_VIDEO") fail("UNSUPPORTED_CONTENT", 400, "YouTube requires one supported short video.");
  if (!content.title || content.title.length > 100 || /[<>]/.test(content.title) || Buffer.byteLength(content.body, "utf8") > 5000)
    fail("UNSUPPORTED_CONTENT", 400, "Use a YouTube title up to 100 characters and description up to 5,000 bytes.");
  if (Object.keys(options).some((key) => !["categoryId", "privacyStatus", "madeForKids", "containsSyntheticMedia"].includes(key)) ||
    typeof options.categoryId !== "string" || !/^\d{1,3}$/.test(options.categoryId) ||
    !["public", "unlisted", "private"].includes(String(options.privacyStatus)) ||
    typeof options.madeForKids !== "boolean" || typeof options.containsSyntheticMedia !== "boolean")
    fail("INVALID_PROVIDER_OPTIONS", 400, "Choose a category, visibility, audience and synthetic-media disclosure for YouTube.");
  return { title: content.title, description: content.body, categoryId: options.categoryId,
    privacyStatus: options.privacyStatus as YouTubeUploadInput["privacyStatus"],
    selfDeclaredMadeForKids: options.madeForKids, containsSyntheticMedia: options.containsSyntheticMedia };
}
function inspectedMedia(media: Pick<SocialProviderCall["media"][number], "mime" | "bytes" | "width" | "height" | "durationMs">) {
  try {
    return validateShortsMedia({ mimeType: media.mime, byteLength: media.bytes, width: media.width,
      height: media.height, durationSeconds: (media.durationMs ?? 0) / 1000 });
  } catch { fail("UNSUPPORTED_CONTENT", 400, "Choose one verified square or vertical video up to three minutes."); }
}
function saved(value: SocialProgress): Progress | undefined {
  if (!Object.keys(value).length) return undefined;
  if (value.provider !== "youtube" || typeof value.revisionId !== "string" || typeof value.mediaId !== "string" ||
    typeof value.channelId !== "string" || !Number.isSafeInteger(value.totalBytes) || Number(value.totalBytes) <= 0 ||
    typeof value.mimeType !== "string" || !["private", "public", "unlisted"].includes(String(value.privacyStatus)) ||
    !Number.isSafeInteger(value.offset) || Number(value.offset) < 0 || Number(value.offset) > Number(value.totalBytes) ||
    (value.sessionUrl !== undefined && typeof value.sessionUrl !== "string") ||
    (value.videoId !== undefined && (typeof value.videoId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.videoId))) ||
    Object.keys(value).some((key) => !["provider", "revisionId", "mediaId", "channelId", "totalBytes", "mimeType", "privacyStatus", "offset", "sessionUrl", "videoId"].includes(key)))
    fail("INVALID_PROVIDER_PROGRESS", 502, "The saved YouTube upload evidence is unavailable.");
  return { ...value } as Progress;
}

/** One isolated instance per durable delivery; credentials and signed URLs never enter progress. */
export class YouTubeSocialProvider implements SocialProvider {
  private bytes?: Uint8Array;
  private readonly mode: "mock" | "live";
  private readonly mediaOrigin: string;
  private readonly maxBytes: number;
  private readonly mediaTimeout: number;
  constructor(private readonly config: YouTubeConfig, media: MediaConfig) {
    // Validate fixed provider configuration before registering an instance.
    new YouTubeClient(config);
    this.mode = config.mockoonBaseUrl ? "mock" : "live";
    let origin: URL;
    try { origin = new URL(media.mediaOrigin); } catch { fail("INVALID_CONFIG", 503, "Configure a trusted social media origin."); }
    if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
      !(origin.protocol === "https:" || (this.mode === "mock" && origin.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))))
      fail("INVALID_CONFIG", 503, "Configure a trusted social media origin.");
    this.mediaOrigin = origin.origin;
    this.maxBytes = media.maxBytes ?? 64 * 1024 * 1024;
    this.mediaTimeout = media.mediaTimeoutMs ?? 20_000;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > 512 * 1024 * 1024 ||
      !Number.isSafeInteger(this.mediaTimeout) || this.mediaTimeout < 1 || this.mediaTimeout > 60_000)
      fail("INVALID_CONFIG", 503, "Configure supported media download limits.");
  }
  private client(call: SocialProviderCall) {
    if (call.mode !== this.mode) fail("CONNECTION_MODE_MISMATCH", 409, "Choose the YouTube connection for this provider mode.");
    if (call.destination.kind !== "YOUTUBE_CHANNEL") fail("UNSUPPORTED_CONTENT", 400, "Choose a verified YouTube channel.");
    return new YouTubeClient({ ...this.config, beforeRequest: call.verifyCurrent });
  }
  private binding(context: SocialProviderContext, call: SocialProviderCall, progress?: Progress) {
    this.client(call);
    const input = controls(context.content);
    if (call.media.length !== 1) fail("UNSUPPORTED_CONTENT", 400, "YouTube requires one verified video.");
    const asset = call.media[0], media = inspectedMedia(asset);
    if (media.byteLength > this.maxBytes) fail("MEDIA_UNAVAILABLE", 413, "This video exceeds the configured delivery size limit.");
    if (progress && (progress.revisionId !== context.revisionId || progress.mediaId !== asset.id ||
      progress.channelId !== call.destination.externalId || progress.totalBytes !== asset.bytes ||
      progress.mimeType !== asset.mime || progress.privacyStatus !== input.privacyStatus))
      fail("INVALID_PROVIDER_PROGRESS", 502, "The saved upload does not belong to this reviewed channel and media.");
    return { input: { ...input, media }, asset };
  }
  private async classified<T>(invoke: () => Promise<T>, uncertain = false): Promise<T> {
    try { return await invoke(); }
    catch (error) {
      if (!(error instanceof YouTubeError)) throw error;
      if (["RECONNECT_REQUIRED", "MISSING_PERMISSION"].includes(error.code)) throw error;
      if (uncertain || error.outcomeUnknown) throw new SocialProviderFailure("TRANSIENT", false);
      if (error.code === "PROVIDER_RATE_LIMITED") throw new SocialProviderFailure("RATE_LIMIT", true);
      if (error.retryable) throw new SocialProviderFailure("TRANSIENT", true);
      throw new SocialProviderFailure("TERMINAL", true);
    }
  }
  async validate(context: SocialProviderContext) {
    await context.rpc("PREPARE", async (call) => {
      this.binding(context, call);
      await this.classified(() => this.client(call).verifyChannel(call.accessToken, call.destination.externalId));
    });
  }
  async prepare(context: SocialProviderContext, value: SocialProgress): Promise<SocialProgress> {
    const progress = saved(value);
    return context.rpc("PREPARE", async (call) => {
      const { asset, input } = this.binding(context, call, progress);
      if (!progress?.videoId) this.bytes = await this.loadMedia(call, asset);
      return progress ?? { provider: "youtube", revisionId: context.revisionId, mediaId: asset.id,
        channelId: call.destination.externalId, totalBytes: asset.bytes, mimeType: asset.mime,
        privacyStatus: input.privacyStatus, offset: 0 };
    });
  }
  async publish(context: SocialProviderContext, value: SocialProgress): Promise<SocialPublished> {
    const progress = saved(value);
    if (!progress) fail("INVALID_PROVIDER_PROGRESS", 502, "Prepare the reviewed YouTube media before publishing.");
    if (!progress.videoId) {
      if (!this.bytes || this.bytes.byteLength !== progress.totalBytes)
        fail("MEDIA_UNAVAILABLE", 503, "The reviewed video must be loaded before uploading.");
      if (!progress.sessionUrl) {
        const session = await context.rpc("PUBLISH", async (call) => {
          const { input } = this.binding(context, call, progress);
          // App scheduling dispatches only when due. Never enqueue native publishAt here.
          return this.classified(() => this.client(call).startResumable(call.accessToken, progress.channelId, input));
        });
        progress.sessionUrl = session.sessionUrl;
        await context.checkpoint({ ...progress });
      } else {
        const proof = await context.rpc("PROCESS", async (call) => {
          this.binding(context, call, progress);
          return this.classified(() => this.client(call).probeUpload(call.accessToken, progress.sessionUrl!, {
            totalBytes: progress.totalBytes, channelId: progress.channelId }), true);
        });
        if (proof.state === "UPLOADED") progress.videoId = proof.videoId;
        else progress.offset = proof.nextOffset;
        await context.checkpoint({ ...progress });
      }
      while (!progress.videoId && progress.offset < progress.totalBytes) {
        const offset = progress.offset;
        const bytes = this.bytes.subarray(offset, Math.min(offset + YOUTUBE_CHUNK_BYTES, progress.totalBytes));
        const receipt = await context.rpc("UPLOAD", async (call) => {
          this.binding(context, call, progress);
          return this.classified(() => this.client(call).uploadChunk(call.accessToken, progress.sessionUrl!, {
            offset, totalBytes: progress.totalBytes, mimeType: progress.mimeType, bytes, channelId: progress.channelId }));
        });
        if (receipt.state === "UPLOADED") { progress.videoId = receipt.videoId; progress.offset = progress.totalBytes; }
        else {
          // An acknowledgement must advance exactly the submitted range. Probe
          // ambiguous/partial receipts rather than silently sending other bytes.
          if (receipt.nextOffset !== offset + bytes.byteLength) throw new SocialProviderFailure("TRANSIENT", false);
          progress.offset = receipt.nextOffset;
        }
        await context.checkpoint({ ...progress });
      }
    }
    this.bytes = undefined;
    if (!progress.videoId) throw new SocialProviderFailure("TRANSIENT", false);
    return context.rpc("PROCESS", async (call) => {
      this.binding(context, call, progress);
      const video = await this.classified(() => this.client(call).videoStatus(call.accessToken, progress.videoId!, progress.channelId), true);
      const result = this.confirmed(video, progress.privacyStatus);
      if (!result) throw new SocialProviderFailure(video.state === "FAILED" ? "TERMINAL" : "TRANSIENT", video.state === "FAILED");
      return result;
    });
  }
  async status(context: SocialProviderContext, value: SocialProgress): Promise<SocialStatusResult> {
    const progress = saved(value);
    // Absence of a receipt after the publish boundary cannot prove nonpublication.
    if (!progress || (!progress.videoId && !progress.sessionUrl)) return { status: "UNKNOWN" };
    return context.rpc("PROCESS", async (call) => {
      this.binding(context, call, progress);
      const proof = await this.classified(() => this.client(call).reconcile(call.accessToken, progress.channelId, {
        videoId: progress.videoId, sessionUrl: progress.sessionUrl, totalBytes: progress.totalBytes }), true);
      if (proof.state === "UPLOADED") {
        progress.videoId = proof.videoId; progress.offset = progress.totalBytes;
        await context.checkpoint({ ...progress });
        const video = await this.classified(() => this.client(call).videoStatus(call.accessToken, proof.videoId, progress.channelId), true);
        const result = this.confirmed(video, progress.privacyStatus);
        return result ? { status: "PUBLISHED", result } : video.state === "FAILED" ? { status: "FAILED", result: { externalId: video.id } } : { status: video.state === "PROCESSING" ? "PENDING" : "UNKNOWN" };
      }
      if (proof.state === "KNOWN") {
        const result = this.confirmed(proof.video, progress.privacyStatus);
        return result ? { status: "PUBLISHED", result } : proof.video.state === "FAILED" ? { status: "FAILED", result: { externalId: proof.video.id } } : { status: proof.video.state === "PROCESSING" ? "PENDING" : "UNKNOWN" };
      }
      if (proof.state === "UPLOADING") {
        progress.offset = proof.nextOffset; await context.checkpoint({ ...progress });
        return { status: proof.nextOffset < progress.totalBytes ? "NOT_PUBLISHED" : "PENDING" };
      }
      return { status: "UNKNOWN" };
    });
  }
  private confirmed(video: YouTubeVideoStatus, privacy: Progress["privacyStatus"]): SocialPublished | undefined {
    if (video.status.publishAt || video.status.privacyStatus !== privacy ||
      video.uploadStatus !== "processed" || video.processingStatus !== "succeeded" ||
      !["READY", "PUBLISHED"].includes(video.state)) return undefined;
    return { externalId: video.id, ...(privacy !== "private" ? { publishUrl: `https://www.youtube.com/watch?v=${video.id}` } : {}) };
  }
  private async loadMedia(call: SocialProviderCall, asset: SocialProviderCall["media"][number]) {
    let url: URL;
    try { url = new URL(asset.url); } catch { fail("MEDIA_UNAVAILABLE", 503, "The verified video download is unavailable."); }
    if (url.origin !== this.mediaOrigin || url.username || url.password || url.hash ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(asset.id) || url.pathname !== `/api/social/media/${asset.id}/content` ||
      [...url.searchParams.keys()].length !== 2 || url.searchParams.getAll("expires").length !== 1 ||
      url.searchParams.getAll("signature").length !== 1 || !/^\d{10}$/.test(url.searchParams.get("expires") ?? "") ||
      !/^[a-f0-9]{64}$/.test(url.searchParams.get("signature") ?? ""))
      fail("MEDIA_UNAVAILABLE", 503, "Use the verified signed media download for this app.");
    await call.verifyCurrent();
    let response: Response;
    try { response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(this.mediaTimeout) }); }
    catch { throw new SocialProviderFailure("TRANSIENT", true); }
    if (response.status !== 200 || !response.body || response.headers.get("content-type")?.split(";")[0] !== asset.mime ||
      response.headers.get("content-length") !== String(asset.bytes)) {
      await response.body?.cancel(); fail("MEDIA_UNAVAILABLE", 503, "The verified video download changed or expired.");
    }
    const chunks: Uint8Array[] = []; let length = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        length += value.byteLength;
        if (length > asset.bytes || length > this.maxBytes) {
          await reader.cancel(); fail("MEDIA_UNAVAILABLE", 503, "The verified video download changed.");
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof SecurityError) throw error;
      throw new SocialProviderFailure("TRANSIENT", true);
    }
    if (length !== asset.bytes) fail("MEDIA_UNAVAILABLE", 503, "The verified video download is incomplete.");
    return new Uint8Array(Buffer.concat(chunks));
  }
}

/** Registration remains inert until the operator and runtime explicitly enable it. */
export function youtubeSocialRegistration(config: YouTubeConfig, media: MediaConfig): SocialProviderRegistration {
  return { platform: "GOOGLE", kind: "YOUTUBE_CHANNEL", modes: [config.mockoonBaseUrl ? "mock" : "live"],
    requiredScopes: [...YOUTUBE_SCOPES], formats: ["SHORT_VIDEO"], mediaFetchWindowMs: 120_000,
    validateContent: (content, assets: readonly SocialMediaAsset[]) => {
      controls(content);
      if (assets.length !== 1) fail("UNSUPPORTED_CONTENT", 400, "YouTube requires one verified video.");
      inspectedMedia(assets[0]);
    }, factory: () => new YouTubeSocialProvider(config, media) };
}
