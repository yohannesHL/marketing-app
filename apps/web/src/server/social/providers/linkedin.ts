import type { DestinationKind, SocialMediaAsset } from "../../../generated/prisma/client";
import { LinkedInClient, LinkedInError, LINKEDIN_MEMBER_SCOPES, LINKEDIN_ORGANIZATION_SCOPES,
  type LinkedInConfig, type LinkedInActor, type LinkedInImagePlan, type LinkedInVideoPlan, type LinkedInPostStatus } from "../../providers/linkedin";
import { fail, SecurityError } from "../../security/errors";
import { SocialProviderFailure, type SocialProgress, type SocialProvider, type SocialProviderCall, type SocialProviderContext,
  type SocialProviderRegistration, type SocialPublished, type SocialStatusResult } from "../types";
type MediaConfig = { mediaOrigin: string; maxBytes?: number; mediaTimeoutMs?: number };
type Plan = LinkedInImagePlan | LinkedInVideoPlan;
type Progress = SocialProgress & { provider: "linkedin"; revisionId: string; authorUrn: string; providerUserId: string;
  authorizationId: string; authorizationGeneration: number; mediaId: string; format: string; visibility: "PUBLIC" | "CONNECTIONS";
  plan?: Plan; uploaded: boolean; partIds: string[]; finalizeStarted: boolean; publishAttempted: boolean;
  postUrn?: string; lifecycleState?: string };
const progressFailure = (): never => fail("INVALID_PROVIDER_PROGRESS", 502, "The saved LinkedIn delivery evidence is unavailable.");
function saved(value: SocialProgress): Progress | undefined {
  if (!Object.keys(value).length) return undefined;
  if (value.provider !== "linkedin" || ["revisionId", "authorUrn", "providerUserId", "authorizationId", "mediaId", "format"].some((key) => typeof value[key] !== "string") ||
    !Number.isSafeInteger(value.authorizationGeneration) || Number(value.authorizationGeneration) < 1 ||
    !["PUBLIC", "CONNECTIONS"].includes(String(value.visibility)) || !["TEXT", "IMAGE", "SHORT_VIDEO"].includes(String(value.format)) ||
    ["uploaded", "finalizeStarted", "publishAttempted"].some((key) => typeof value[key] !== "boolean") ||
    !Array.isArray(value.partIds) || value.partIds.some((id) => typeof id !== "string" || !id || id.length > 4096 || /[\r\n]/.test(id)) ||
    (value.postUrn !== undefined && (typeof value.postUrn !== "string" || !/^urn:li:(?:share|ugcPost):\d{1,30}$/.test(value.postUrn))) ||
    (value.lifecycleState !== undefined && !["PUBLISHED", "PUBLISH_REQUESTED", "PUBLISH_FAILED", "DRAFT"].includes(String(value.lifecycleState))) ||
    Object.keys(value).some((key) => !["provider", "revisionId", "authorUrn", "providerUserId", "authorizationId", "authorizationGeneration", "mediaId", "format", "visibility", "plan", "uploaded", "partIds", "finalizeStarted", "publishAttempted", "postUrn", "lifecycleState"].includes(key))) return progressFailure();
  if (value.plan !== undefined) {
    const p = value.plan as Plan;
    if (!p || typeof p !== "object" || !["IMAGE", "VIDEO"].includes(p.type) || p.ownerUrn !== value.authorUrn ||
      typeof p.mediaUrn !== "string" || !new RegExp(`^urn:li:${p.type === "IMAGE" ? "image" : "video"}:[A-Za-z0-9_-]{1,255}$`).test(p.mediaUrn) ||
      !Number.isSafeInteger(p.expiresAt) || p.expiresAt <= 0) return progressFailure();
    if (p.type === "IMAGE") {
      if (value.format !== "IMAGE" || typeof p.uploadUrl !== "string" || value.partIds.length) return progressFailure();
    } else if (value.format !== "SHORT_VIDEO" || !Number.isSafeInteger(p.totalBytes) || p.totalBytes < 75000 || p.totalBytes > 500 * 1024 * 1024 ||
      typeof p.uploadToken !== "string" || p.uploadToken.length > 32768 || !Array.isArray(p.parts) || !p.parts.length || p.parts.length > 128 ||
      value.partIds.length > p.parts.length || p.parts.some((part, i) => !part || typeof part.uploadUrl !== "string" || !Number.isSafeInteger(part.firstByte) ||
        !Number.isSafeInteger(part.lastByte) || part.firstByte !== (i ? p.parts[i - 1].lastByte + 1 : 0) || part.lastByte < part.firstByte ||
        part.lastByte - part.firstByte + 1 > 4194304) || p.parts.at(-1)!.lastByte !== p.totalBytes - 1) return progressFailure();
  } else if (value.format === "TEXT" && (value.partIds.length || value.finalizeStarted)) return progressFailure();
  if (value.postUrn && !value.publishAttempted) return progressFailure();
  return structuredClone(value) as Progress;
}
function controls(content: SocialProviderContext["content"], organization: boolean) {
  const options = content.providerOptions;
  if (!content.body.trim() || content.body.length > 3000 || content.title.length > 200 ||
    Object.keys(options).some((key) => key !== "visibility") || !["PUBLIC", "CONNECTIONS"].includes(String(options.visibility)) ||
    (organization && options.visibility !== "PUBLIC")) fail("INVALID_PROVIDER_OPTIONS", 400, "Choose supported LinkedIn text and an explicit visibility for this author.");
  return { commentary: content.body, visibility: options.visibility as Progress["visibility"], ...(content.title ? { title: content.title } : {}) };
}
function mediaChecked(content: SocialProviderContext["content"], assets: readonly Pick<SocialProviderCall["media"][number], "mime" | "bytes" | "width" | "height" | "durationMs">[], max: number) {
  if (content.format === "TEXT") { if (assets.length) fail("UNSUPPORTED_CONTENT", 400, "LinkedIn text posts cannot contain media."); return; }
  if (assets.length !== 1) fail("UNSUPPORTED_CONTENT", 400, "Choose one verified LinkedIn image or video.");
  const a = assets[0];
  if (!Number.isSafeInteger(a.bytes) || a.bytes <= 0 || a.bytes > max || !Number.isSafeInteger(a.width) || !Number.isSafeInteger(a.height) || a.width < 1 || a.height < 1 ||
    (content.format === "IMAGE" ? !["image/png", "image/jpeg"].includes(a.mime) || a.width * a.height >= 36152320 || a.bytes > 64 * 1024 * 1024 :
      content.format !== "SHORT_VIDEO" || a.mime !== "video/mp4" || a.bytes < 75000 || a.durationMs === null || a.durationMs < 3000 || a.durationMs > 1800000))
    fail("UNSUPPORTED_CONTENT", 400, "Use one verified supported LinkedIn image or MP4 video within the delivery limits.");
}
/** Isolated per delivery. Signed upload plans remain encrypted worker progress. */
export class LinkedInSocialProvider implements SocialProvider {
  private readonly mode: "mock" | "live";
  private readonly mediaOrigin: string;
  private readonly maxBytes: number;
  private readonly timeout: number;
  constructor(private readonly config: LinkedInConfig, media: MediaConfig) {
    new LinkedInClient(config); this.mode = config.mockoonBaseUrl ? "mock" : "live";
    let url: URL; try { url = new URL(media.mediaOrigin); } catch { fail("INVALID_CONFIG", 503, "Configure a trusted media origin."); }
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || !(url.protocol === "https:" ||
      (this.mode === "mock" && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) fail("INVALID_CONFIG", 503, "Configure a trusted media origin.");
    this.mediaOrigin = url.origin; this.maxBytes = media.maxBytes ?? 64 * 1024 * 1024; this.timeout = media.mediaTimeoutMs ?? 20000;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > 500 * 1024 * 1024 ||
      !Number.isSafeInteger(this.timeout) || this.timeout < 1 || this.timeout > 60000) fail("INVALID_CONFIG", 503, "Configure supported media limits.");
  }
  private binding(context: SocialProviderContext, call: SocialProviderCall, p?: Progress) {
    if (call.mode !== this.mode) fail("CONNECTION_MODE_MISMATCH", 409, "Choose the LinkedIn connection for this provider mode.");
    const organization = call.destination.kind === "LINKEDIN_ORGANIZATION";
    if (!organization && call.destination.kind !== "LINKEDIN_MEMBER" || !new RegExp(organization ? "^urn:li:organization:\\d{1,25}$" : "^urn:li:person:[A-Za-z0-9_-]{1,255}$").test(call.destination.externalId))
      fail("UNSUPPORTED_CONTENT", 400, "Choose a verified LinkedIn publishing author.");
    if (!call.providerUserId || !call.authorizationId || !Number.isSafeInteger(call.authorizationGeneration) || Number(call.authorizationGeneration) < 1)
      fail("PROVIDER_IDENTITY_MISMATCH", 409, "Verify the LinkedIn authorization identity before publishing.");
    const input = controls(context.content, organization); mediaChecked(context.content, call.media, this.maxBytes);
    const actor: LinkedInActor = { providerUserId: call.providerUserId, authorUrn: call.destination.externalId };
    if (p && (p.revisionId !== context.revisionId || p.authorUrn !== actor.authorUrn || p.providerUserId !== actor.providerUserId ||
      p.authorizationId !== call.authorizationId || p.authorizationGeneration !== call.authorizationGeneration || p.format !== context.content.format ||
      p.visibility !== input.visibility || p.mediaId !== (call.media[0]?.id ?? "") ||
      (p.plan?.type === "VIDEO" && p.plan.totalBytes !== call.media[0]?.bytes))) return progressFailure();
    return { input, actor, asset: call.media[0], client: new LinkedInClient({ ...this.config, beforeRequest: call.verifyCurrent }) };
  }
  private async classified<T>(invoke: () => Promise<T>, uncertain = false): Promise<T> {
    try { return await invoke(); } catch (e) {
      if (!(e instanceof LinkedInError)) throw e;
      if (["RECONNECT_REQUIRED", "MISSING_PERMISSION", "READ_CAPABILITY_REQUIRED", "AUTHOR_MISMATCH", "PROVIDER_IDENTITY_MISMATCH", "ORGANIZATION_ROLE_REQUIRED"].includes(e.code)) throw e;
      if (uncertain || e.outcomeUnknown) throw new SocialProviderFailure("TRANSIENT", false);
      if (e.code === "PROVIDER_RATE_LIMITED") throw new SocialProviderFailure("RATE_LIMIT", true);
      if (e.retryable || ["MEDIA_NOT_READY", "MEDIA_EXPIRED"].includes(e.code)) throw new SocialProviderFailure("TRANSIENT", true);
      throw new SocialProviderFailure("TERMINAL", true);
    }
  }
  async validate(context: SocialProviderContext) {
    await context.rpc("PREPARE", async (call) => { const { client, actor } = this.binding(context, call); await this.classified(() => client.verifyAuthor(call.accessToken, actor)); });
  }
  async prepare(context: SocialProviderContext, value: SocialProgress): Promise<SocialProgress> {
    let p = saved(value);
    await context.rpc("PREPARE", async (call) => {
      const { actor, input } = this.binding(context, call, p);
      p ??= { provider: "linkedin", revisionId: context.revisionId, authorUrn: actor.authorUrn, providerUserId: actor.providerUserId,
        authorizationId: call.authorizationId!, authorizationGeneration: call.authorizationGeneration!, mediaId: call.media[0]?.id ?? "",
        format: context.content.format, visibility: input.visibility, uploaded: false, partIds: [], finalizeStarted: false, publishAttempted: false };
    });
    const progress = p!;
    if (progress.postUrn || progress.publishAttempted || progress.format === "TEXT") return progress;
    let bytes: Uint8Array | undefined;
    if (!progress.plan) {
      bytes = await context.rpc("PREPARE", async (call) => { const { asset } = this.binding(context, call, progress); return this.loadMedia(call, asset); });
      progress.plan = await context.rpc("UPLOAD", async (call) => {
        const { client, actor, asset } = this.binding(context, call, progress);
        return this.classified<Plan>(() => progress.format === "IMAGE" ? client.initializeImage(call.accessToken, actor) : client.initializeVideo(call.accessToken, actor, asset.bytes));
      });
      await context.checkpoint({ ...progress });
    } else {
      const state = await this.readMedia(context, progress);
      if (state === "AVAILABLE") { progress.uploaded = true; await context.checkpoint({ ...progress }); return progress; }
      if (state === "PROCESSING_FAILED") throw new SocialProviderFailure("TERMINAL", true);
      // Reads can safely poll the saved asset without restarting an upload.
      if (state !== "WAITING_UPLOAD" || progress.finalizeStarted || progress.uploaded) throw new SocialProviderFailure("TRANSIENT", true);
    }
    bytes ??= await context.rpc("PREPARE", async (call) => { const { asset } = this.binding(context, call, progress); return this.loadMedia(call, asset); });
    const plan = progress.plan!;
    if (plan.type === "IMAGE") {
      await context.rpc("UPLOAD", async (call) => { const { client, actor } = this.binding(context, call, progress);
        return this.classified(() => client.uploadImage(call.accessToken, actor, plan, bytes!)); });
    } else {
      for (let i = progress.partIds.length; i < plan.parts.length; i++) {
        const part = plan.parts[i];
        const etag = await context.rpc("UPLOAD", async (call) => { const { client, actor } = this.binding(context, call, progress);
          return this.classified(() => client.uploadPart(call.accessToken, actor, plan, i, bytes!.subarray(part.firstByte, part.lastByte + 1))); });
        progress.partIds.push(etag); await context.checkpoint({ ...progress });
      }
      progress.finalizeStarted = true; await context.checkpoint({ ...progress });
      await context.rpc("UPLOAD", async (call) => { const { client, actor } = this.binding(context, call, progress);
        return this.classified(() => client.finalizeVideo(call.accessToken, actor, plan, progress.partIds)); });
    }
    progress.uploaded = true; await context.checkpoint({ ...progress });
    const state = await this.readMedia(context, progress);
    if (state === "PROCESSING_FAILED") throw new SocialProviderFailure("TERMINAL", true);
    if (state !== "AVAILABLE") throw new SocialProviderFailure("TRANSIENT", true);
    return progress;
  }
  private async readMedia(context: SocialProviderContext, p: Progress) {
    return context.rpc("PROCESS", async (call) => { const { client, actor } = this.binding(context, call, p);
      return (await this.classified(() => client.mediaStatus(call.accessToken, actor, p.plan!.mediaUrn))).status; });
  }
  async publish(context: SocialProviderContext, value: SocialProgress): Promise<SocialPublished> {
    const p = saved(value); if (!p) return progressFailure();
    if (!p.postUrn) {
      if (p.publishAttempted) throw new SocialProviderFailure("TRANSIENT", false);
      if (p.format !== "TEXT" && (!p.plan || !p.uploaded)) return progressFailure();
      const receipt = await context.rpc("PUBLISH", async (call) => {
        const { client, actor, input } = this.binding(context, call, p);
        p.publishAttempted = true; await context.checkpoint({ ...p });
        try { return await this.classified(() => client.createPost(call.accessToken, actor, { ...input, ...(p.plan ? { mediaUrn: p.plan.mediaUrn } : {}) })); }
        catch (e) { if (e instanceof SocialProviderFailure && e.definitive) { p.publishAttempted = false; await context.checkpoint({ ...p }); } throw e; }
      });
      p.postUrn = receipt.postUrn; await context.checkpoint({ ...p });
    }
    const status = await this.status(context, p);
    if (status.status !== "PUBLISHED") throw new SocialProviderFailure("TRANSIENT", false);
    return status.result;
  }
  async status(context: SocialProviderContext, value: SocialProgress): Promise<SocialStatusResult> {
    const p = saved(value); if (!p) return { status: "UNKNOWN" };
    if (!p.postUrn) {
      await context.rpc("PROCESS", async (call) => { this.binding(context, call, p); });
      if (p.publishAttempted) return { status: "UNKNOWN" };
      if (!p.plan) return { status: "NOT_PUBLISHED" };
      const media = await this.readMedia(context, p);
      return media === "PROCESSING_FAILED" ? { status: "FAILED", result: { externalId: p.plan.mediaUrn } } :
        media === "PROCESSING" ? { status: "PENDING" } : { status: "NOT_PUBLISHED" };
    }
    return context.rpc("PROCESS", async (call) => {
      const { client, actor } = this.binding(context, call, p);
      const post: LinkedInPostStatus = await this.classified(() => client.postStatus(call.accessToken, actor, p.postUrn!), true);
      if (post.visibility !== p.visibility || post.mediaUrn !== p.plan?.mediaUrn) return { status: "UNKNOWN" };
      p.lifecycleState = post.lifecycleState; await context.checkpoint({ ...p });
      return post.state === "FAILED" ? { status: "FAILED", result: { externalId: post.postUrn } } : post.state === "PUBLISHED" ?
        { status: "PUBLISHED", result: { externalId: post.postUrn, publishUrl: `https://www.linkedin.com/feed/update/${post.postUrn}/` } } :
        { status: post.state === "PENDING" ? "PENDING" : "UNKNOWN" };
    });
  }
  private async loadMedia(call: SocialProviderCall, asset: SocialProviderCall["media"][number]) {
    let url: URL; try { url = new URL(asset.url); } catch { fail("MEDIA_UNAVAILABLE", 503, "Use the verified signed media download for this app."); }
    if (url.origin !== this.mediaOrigin || url.username || url.password || url.hash || !/^[A-Za-z0-9_-]{1,128}$/.test(asset.id) ||
      url.pathname !== `/api/social/media/${asset.id}/content` || [...url.searchParams.keys()].length !== 2 || url.searchParams.getAll("expires").length !== 1 ||
      url.searchParams.getAll("signature").length !== 1 || !/^\d{10}$/.test(url.searchParams.get("expires") ?? "") || !/^[a-f0-9]{64}$/.test(url.searchParams.get("signature") ?? ""))
      fail("MEDIA_UNAVAILABLE", 503, "Use the verified signed media download for this app.");
    await call.verifyCurrent(); let response: Response;
    try { response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(this.timeout) }); } catch { throw new SocialProviderFailure("TRANSIENT", true); }
    if (response.status !== 200 || !response.body || response.headers.get("content-type")?.split(";")[0] !== asset.mime || response.headers.get("content-length") !== String(asset.bytes)) {
      await response.body?.cancel(); fail("MEDIA_UNAVAILABLE", 503, "The verified media download changed or expired.");
    }
    const chunks: Uint8Array[] = []; let length = 0; const reader = response.body.getReader();
    try { while (true) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength;
      if (length > asset.bytes || length > this.maxBytes) { await reader.cancel(); fail("MEDIA_UNAVAILABLE", 503, "The verified media download changed."); } chunks.push(value); }
    } catch (e) { if (e instanceof SecurityError) throw e; throw new SocialProviderFailure("TRANSIENT", true); }
    if (length !== asset.bytes) fail("MEDIA_UNAVAILABLE", 503, "The verified media download is incomplete."); return new Uint8Array(Buffer.concat(chunks));
  }
}
export function linkedinSocialRegistration(config: LinkedInConfig, media: MediaConfig, kind: "LINKEDIN_MEMBER" | "LINKEDIN_ORGANIZATION"): SocialProviderRegistration {
  new LinkedInClient(config);
  return { platform: "LINKEDIN", kind, modes: [config.mockoonBaseUrl ? "mock" : "live"],
    requiredScopes: kind === "LINKEDIN_MEMBER" ? [...LINKEDIN_MEMBER_SCOPES, "r_member_social"] : [...LINKEDIN_ORGANIZATION_SCOPES],
    renewableCredentials: config.mdpRefreshEnabled === true, formats: ["TEXT", "IMAGE", "SHORT_VIDEO"], mediaFetchWindowMs: 120000,
    validateContent: (content, assets: readonly SocialMediaAsset[]) => { controls(content, kind === "LINKEDIN_ORGANIZATION"); mediaChecked(content, assets, media.maxBytes ?? 64 * 1024 * 1024); },
    factory: () => new LinkedInSocialProvider(config, media) };
}
