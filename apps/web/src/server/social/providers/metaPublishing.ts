import type { SocialMediaAsset } from "../../../generated/prisma/client";
import { MetaPublishingClient, MetaPublishingError, META_PUBLISHING_SCOPES,
  type MetaPublishingConfig, type MetaPageCredential, type MetaPublishingKind, type VerifiedMetaPublishingTarget } from "../../providers/metaPublishing";
import { fail } from "../../security/errors";
import { SocialProviderFailure, type SocialProgress, type SocialProvider, type SocialProviderCall,
  type SocialProviderContext, type SocialProviderRegistration, type SocialPublished, type SocialStatusResult } from "../types";

export type MetaSocialProviderConfig = Omit<MetaPublishingConfig,"beforeRequest"> & {
  mediaOrigin: string;
  /** Root resolves encrypted Page credentials only within this checked RPC. Never destination metadata. */
  resolvePageCredential(call: SocialProviderCall): Promise<MetaPageCredential>;
};
type Media = Pick<SocialMediaAsset,"mime"|"bytes"|"width"|"height"|"durationMs"|"metadata">;
type Progress = SocialProgress & {provider:"meta";revisionId:string;kind:MetaPublishingKind;targetId:string;pageId:string;
  format:string;mediaId?:string;initializationStarted?:boolean;initializedAt?:number;photoId?:string;
  videoId?:string;uploadUrl?:string;uploadStarted?:boolean;uploaded?:boolean;containerId?:string;externalId?:string};
const terminal = (): never => { throw new SocialProviderFailure("TERMINAL",false); };
const pending = (): never => { throw new SocialProviderFailure("TRANSIENT",true,30_000); };
function controls(kind:MetaPublishingKind, content:SocialProviderContext["content"]) {
  const allowed = kind === "FACEBOOK_PAGE" && content.format === "SHORT_VIDEO" ? ["isAigc"] :
    kind === "INSTAGRAM_PROFILE" && content.format === "SHORT_VIDEO" ? ["shareToFeed"] : [];
  if (Object.keys(content.providerOptions).some(key => !allowed.includes(key)) ||
    allowed.some(key => typeof content.providerOptions[key] !== "boolean"))
    fail("INVALID_PROVIDER_OPTIONS",400,"Choose the required Meta publishing controls.");
  if (content.body.length > (kind === "INSTAGRAM_PROFILE" ? 2200 : 63206) ||
    (kind === "INSTAGRAM_PROFILE" && content.format === "TEXT") ||
    (kind === "FACEBOOK_PAGE" && content.format === "TEXT" && !content.body.trim()))
    fail("UNSUPPORTED_CONTENT",400,"Choose supported content and a caption within the platform limit.");
}
function mediaFormat(kind:MetaPublishingKind, content:SocialProviderContext["content"], media:readonly Media[]) {
  controls(kind,content);
  if (content.format === "TEXT") { if (media.length) fail("UNSUPPORTED_CONTENT",400,"Text posts cannot contain media."); return; }
  if (media.length !== 1) fail("UNSUPPORTED_CONTENT",400,"Choose exactly one verified media asset.");
  const asset = media[0];
  if (content.format === "IMAGE") {
    const ratio = asset.width/asset.height;
    const valid = kind === "INSTAGRAM_PROFILE" ? asset.mime === "image/jpeg" && asset.bytes <= 8_000_000 &&
      asset.width >= 320 && asset.width <= 1440 && ratio >= 4/5 && ratio <= 1.91 :
      ["image/jpeg","image/png"].includes(asset.mime) && asset.bytes <= 8_000_000;
    if (!valid || asset.width <= 0 || asset.height <= 0) fail("UNSUPPORTED_CONTENT",400,"Choose an image that meets the platform's format and size limits.");
    return;
  }
  const probe = asset.metadata && typeof asset.metadata === "object" && !Array.isArray(asset.metadata) ? asset.metadata as Record<string,unknown> : {};
  const seconds = (asset.durationMs ?? 0)/1000, fps = Number(probe.fps);
  const common = asset.mime === "video/mp4" && probe.container === "mp4" && ["h264","hevc"].includes(String(probe.videoCodec)) &&
    ["","aac"].includes(String(probe.audioCodec)) && Number.isFinite(fps) && fps <= 60 && seconds >= 3 && asset.bytes > 0;
  const valid = kind === "FACEBOOK_PAGE" ? common && seconds <= 90 && fps >= 24 && asset.width >= 540 && asset.height >= 960 &&
    Math.abs(asset.width/asset.height - 9/16) < 0.001 : common && seconds <= 15*60 && fps >= 23 &&
    asset.width <= 1920 && asset.bytes <= 300_000_000 &&
    (probe.audioCodec === "" || Number(probe.audioSampleRate) === 48000) && asset.width/asset.height >= 0.01 && asset.width/asset.height <= 10;
  if (!valid) fail("UNSUPPORTED_CONTENT",400,"Choose a verified MP4 Reel within the platform's duration, dimensions, frame rate and size limits.");
}
function saved(progress:SocialProgress):Progress|undefined {
  if (!Object.keys(progress).length) return;
  if (progress.provider !== "meta" || typeof progress.revisionId !== "string" || !["FACEBOOK_PAGE","INSTAGRAM_PROFILE"].includes(String(progress.kind)) ||
    typeof progress.targetId !== "string" || !/^\d+$/.test(progress.targetId) || typeof progress.pageId !== "string" || !/^\d+$/.test(progress.pageId) ||
    !["TEXT","IMAGE","SHORT_VIDEO"].includes(String(progress.format))) return terminal();
  for (const key of ["photoId","videoId","containerId"]) if (progress[key] !== undefined && (typeof progress[key] !== "string" || !/^\d{1,64}$/.test(String(progress[key])))) return terminal();
  if (progress.initializedAt !== undefined && (!Number.isSafeInteger(progress.initializedAt) || Number(progress.initializedAt) < 0)) return terminal();
  return progress as Progress;
}

/** Per-delivery adapter. No tokens or signed URLs escape a guarded RPC or encrypted checkpoint. */
export class MetaSocialProvider implements SocialProvider {
  constructor(readonly kind:MetaPublishingKind, readonly config:MetaSocialProviderConfig) {
    const origin = new URL(config.mediaOrigin);
    if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
      (origin.protocol !== "https:" && !(config.mode === "mock" && origin.protocol === "http:" && ["127.0.0.1","localhost","[::1]"].includes(origin.hostname))))
      throw new MetaPublishingError("INVALID_PROVIDER_CONFIG",500);
    // Validates mode and fixture configuration before any job is accepted.
    new MetaPublishingClient(config);
  }
  async #checked<T>(call:SocialProviderCall, invoke:(client:MetaPublishingClient,target:VerifiedMetaPublishingTarget)=>Promise<T>) {
    if (call.mode !== (this.config.mode ?? "live") || call.destination.kind !== this.kind) return terminal();
    await call.verifyCurrent();
    const credential = await this.config.resolvePageCredential(call);
    const client = new MetaPublishingClient({...this.config,beforeRequest:call.verifyCurrent});
    try {
      const target = await client.verifyTarget(call.accessToken,credential,this.kind,call.destination.externalId,call.providerUserId);
      return await invoke(client,target);
    } catch (error) {
      if (!(error instanceof MetaPublishingError)) throw error;
      throw new SocialProviderFailure(error.code === "RATE_LIMIT" ? "RATE_LIMIT" : error.code === "TRANSIENT" || error.code === "NETWORK_ERROR" ? "TRANSIENT" :
        error.code === "RECONNECT_REQUIRED" ? "EXPIRED" : "TERMINAL",error.definitive,error.retryAfterMs);
    }
  }
  #media(call:SocialProviderCall, context:SocialProviderContext) {
    mediaFormat(this.kind,context.content,call.media.map(m => ({...m,metadata:(m as typeof m & {metadata?:SocialMediaAsset["metadata"]}).metadata ?? null})));
    for (const media of call.media) {
      let url: URL; try { url = new URL(media.url); } catch { return terminal(); }
      if (url.origin !== new URL(this.config.mediaOrigin).origin || url.username || url.password || url.hash ||
        url.pathname !== `/api/social/media/${media.id}/content` || !url.searchParams.get("signature") || !/^\d{10}$/.test(url.searchParams.get("expires") ?? "") ||
        Number(url.searchParams.get("expires"))*1000 < (this.config.now?.() ?? new Date()).getTime()+30*60*1000) return terminal();
    }
    return call.media[0];
  }
  async validate(context:SocialProviderContext) {
    await context.rpc("PREPARE",call => this.#checked(call,async () => {this.#media(call,context);}));
  }
  #bind(context:SocialProviderContext, progress:Progress, target:VerifiedMetaPublishingTarget, mediaId?:string) {
    if (progress.revisionId !== context.revisionId || progress.kind !== this.kind || progress.targetId !== target.externalId ||
      progress.pageId !== target.pageId || progress.format !== context.content.format || progress.mediaId !== mediaId) return terminal();
  }
  async prepare(context:SocialProviderContext, input:SocialProgress):Promise<SocialProgress> {
    let progress = saved(input);
    await context.rpc("PREPARE",call => this.#checked(call,async (client,target) => {
      const media = this.#media(call,context);
      progress ??= {provider:"meta",revisionId:context.revisionId,kind:this.kind,targetId:target.externalId,pageId:target.pageId,
        format:context.content.format,...(media ? {mediaId:media.id} : {})};
      this.#bind(context,progress,target,media?.id);
      if (context.content.format === "TEXT") return;
      if (progress.initializedAt !== undefined && (this.config.now?.() ?? new Date()).getTime() - progress.initializedAt >= 24*60*60*1000) throw new SocialProviderFailure("EXPIRED",true);
      const known = progress.photoId || progress.videoId || progress.containerId;
      if (!known && progress.initializationStarted) return terminal(); // Unknown creation response: never create a second resource.
      if (!known) {
        progress.initializationStarted = true; progress.initializedAt = (this.config.now?.() ?? new Date()).getTime();
        await context.checkpoint(progress);
        try {
          if (this.kind === "FACEBOOK_PAGE" && context.content.format === "IMAGE") progress.photoId = await client.createPhoto(target,media.url);
          else if (this.kind === "FACEBOOK_PAGE") Object.assign(progress,await client.startReel(target));
          else progress.containerId = await client.createContainer(target,context.content.format as "IMAGE"|"SHORT_VIDEO",media.url,context.content.body,context.content.providerOptions.shareToFeed as boolean);
        } catch (error) {
          // Only an authoritative rejection proves no resource was created. Unknown responses keep the durable marker.
          if (error instanceof MetaPublishingError && error.definitive) {
            progress.initializationStarted = false; delete progress.initializedAt; await context.checkpoint(progress);
          }
          throw error;
        }
        await context.checkpoint(progress);
      }
      if (progress.videoId) {
        if (!progress.uploadStarted) {
          progress.uploadStarted = true; await context.checkpoint(progress);
          await client.uploadReel(target,progress.videoId,String(progress.uploadUrl),media.url);
          progress.uploaded = true; await context.checkpoint(progress);
        }
        const status = await client.reelStatus(target,progress.videoId);
        if (status === "PROCESSING") return pending();
        if (status !== "READY") return terminal();
      }
      if (progress.containerId) {
        const status = await client.containerStatus(target,progress.containerId);
        if (status === "IN_PROGRESS") return pending();
        if (status === "EXPIRED") throw new SocialProviderFailure("EXPIRED",true);
        if (status !== "FINISHED") return terminal();
      }
    }));
    return progress!;
  }
  async publish(context:SocialProviderContext, input:SocialProgress):Promise<SocialPublished> {
    const progress = saved(input); if (!progress || progress.externalId) return terminal();
    await context.rpc("PUBLISH",call => this.#checked(call,async (client,target) => {
      const media = this.#media(call,context); this.#bind(context,progress,target,media?.id);
      if (progress.initializedAt !== undefined && (this.config.now?.() ?? new Date()).getTime() - progress.initializedAt >= 24*60*60*1000)
        throw new SocialProviderFailure("EXPIRED",true);
      if (this.kind === "INSTAGRAM_PROFILE") {
        if (!progress.containerId) return terminal();
        progress.externalId = await client.publishContainer(target,progress.containerId);
      } else if (progress.videoId) {
        if (await client.reelStatus(target,progress.videoId) !== "READY") return pending();
        await client.finishReel(target,progress.videoId,context.content.body,context.content.title,context.content.providerOptions.isAigc as boolean);
      } else progress.externalId = await client.publishFeed(target,context.content.body,progress.photoId);
    }));
    await context.checkpoint(progress);
    const status = await this.status(context,progress);
    if (status.status === "PUBLISHED") return status.result;
    // An accepted submission plus unfinished processing must remain ambiguous, regardless of a later read failure.
    throw new SocialProviderFailure("TRANSIENT",false,30_000);
  }
  async status(context:SocialProviderContext, input:SocialProgress):Promise<SocialStatusResult> {
    const progress = saved(input); if (!progress || progress.revisionId !== context.revisionId) return {status:"UNKNOWN"};
    return context.rpc("PROCESS",call => this.#checked(call,async (client,target):Promise<SocialStatusResult> => {
      this.#bind(context,progress,target,progress.mediaId);
      if (progress.externalId) {
        const result = await client.publishedStatus(target,progress.externalId);
        return result.published ? {status:"PUBLISHED",result:{externalId:result.externalId,...(result.publishUrl ? {publishUrl:result.publishUrl} : {})}} : {status:"PENDING"};
      }
      if (progress.videoId) {
        const result = await client.reelStatus(target,progress.videoId);
        if (result === "PUBLISHED") return {status:"PUBLISHED",result:{externalId:progress.videoId}};
        return result === "ERROR" ? {status:"FAILED",result:{externalId:progress.videoId}} : {status:"PENDING"};
      }
      if (progress.containerId) {
        const result = await client.containerStatus(target,progress.containerId);
        // PUBLISHED without media ID proves acceptance but cannot fabricate a receipt or repeat media_publish.
        if (result === "ERROR") return {status:"FAILED",result:{externalId:progress.containerId}};
        return {status:result === "IN_PROGRESS" || result === "FINISHED" ? "PENDING" : "UNKNOWN"};
      }
      return {status:"UNKNOWN"};
    }));
  }
}
export function metaPublishingRegistration(kind:MetaPublishingKind, config:MetaSocialProviderConfig):SocialProviderRegistration {
  return {platform:"META",kind,modes:[config.mode ?? "live"],requiredScopes:[...META_PUBLISHING_SCOPES],
    formats:kind === "FACEBOOK_PAGE" ? ["TEXT","IMAGE","SHORT_VIDEO"] : ["IMAGE","SHORT_VIDEO"],mediaFetchWindowMs:30*60*1000,
    validateContent:(content,media) => mediaFormat(kind,content,media),factory:() => new MetaSocialProvider(kind,config)};
}
