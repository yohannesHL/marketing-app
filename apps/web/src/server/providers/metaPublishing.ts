import { createHmac } from "node:crypto";
import type { ProviderGrant } from "../connections/customerConnections";
export type VerifiedMetaPublishingGrant = ProviderGrant & {displayName:string;dataAccessExpiresAt:Date|null;tokenType:"USER"};

export const META_PUBLISHING_SCOPES = ["public_profile", "pages_show_list", "pages_read_engagement", "pages_manage_posts", "instagram_basic", "instagram_content_publish"] as const;
export type MetaPublishingKind = "FACEBOOK_PAGE" | "INSTAGRAM_PROFILE";
export type MetaPageCredential = { pageId: string; accessToken: string };
export type MetaSocialDestination = {
  externalId: string; kind: MetaPublishingKind; pageId: string; name: string;
  username?: string; tasks: string[]; canPublish: boolean;
};
/** This proof has no enumerable credentials. It is valid only in the issuing client. */
export type VerifiedMetaPublishingTarget = Readonly<MetaSocialDestination>;
export type MetaPublishingConfig = {
  appId: string; appSecret: string; configId: string; redirectUri: string;
  graphVersion?: string; mode?: "mock" | "live"; testBaseUrl?: string;
  beforeRequest?: () => Promise<void>; now?: () => Date;
};
export class MetaPublishingError extends Error {
  constructor(readonly code: string, readonly status = 502,
    readonly definitive = false, readonly retryAfterMs?: number) {
    super("The Meta publishing request could not be completed.");
    this.name = "MetaPublishingError";
  }
}
type Json = Record<string, unknown>;
const invalid = (): never => { throw new MetaPublishingError("INVALID_PROVIDER_RESPONSE"); };
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : invalid();
const string = (value: unknown, max = 32768): string => typeof value === "string" && value.length > 0 && value.length <= max ? value : invalid();
const id = (value: unknown): string => /^\d{1,64}$/.test(string(value, 64)) ? value as string : invalid();
const list = (value: unknown): string[] => Array.isArray(value) && value.length <= 100 && value.every(v => typeof v === "string" && v.length > 0 && v.length <= 512) ? [...new Set(value)] as string[] : invalid();
const loopback = (hostname: string) => ["127.0.0.1", "localhost", "[::1]"].includes(hostname);
function parseUrl(value:string, base?:string, configuration=false) {
  try { return new URL(value,base); } catch { throw new MetaPublishingError(configuration ? "INVALID_PROVIDER_CONFIG" : "INVALID_PROVIDER_RESPONSE",configuration ? 500 : 502); }
}
const expiry = (value: unknown): Date | null => {
  if (value === 0) return null;
  if (!Number.isSafeInteger(value) || Number(value) <= 0) return invalid();
  const date = new Date(Number(value) * 1000); return Number.isFinite(date.getTime()) ? date : invalid();
};

/** Facebook Login for Business USER configuration dedicated to SOCIAL. No Ads inheritance. */
export class MetaPublishingClient {
  readonly pkce = false;
  readonly scopes = [...META_PUBLISHING_SCOPES];
  readonly graphVersion: string;
  readonly mode: "mock" | "live";
  readonly redirectUri: string;
  readonly #config: MetaPublishingConfig;
  readonly #origin: string;
  readonly #now: () => Date;
  readonly #credentials = new WeakMap<VerifiedMetaPublishingTarget, {accessToken:string;expiresAt:Date|null}>();
  constructor(config: MetaPublishingConfig) {
    id(config.appId); id(config.configId); string(config.appSecret);
    this.graphVersion = config.graphVersion ?? "v26.0";
    if (!/^v(21|22|23|24|25|26)\.0$/.test(this.graphVersion)) throw new MetaPublishingError("INVALID_PROVIDER_CONFIG", 500);
    this.mode = config.mode ?? "live";
    const redirect = parseUrl(config.redirectUri,undefined,true);
    if (redirect.username || redirect.password || redirect.search || redirect.hash ||
      (redirect.protocol !== "https:" && !(redirect.protocol === "http:" && loopback(redirect.hostname))))
      throw new MetaPublishingError("INVALID_PROVIDER_CONFIG", 500);
    this.redirectUri = redirect.href; this.#origin = "https://graph.facebook.com";
    if (config.testBaseUrl) {
      const test = parseUrl(config.testBaseUrl,undefined,true);
      if (this.mode !== "mock" || test.protocol !== "http:" || !loopback(test.hostname) || test.username || test.password ||
        test.pathname !== "/" || test.search || test.hash) throw new MetaPublishingError("INVALID_PROVIDER_CONFIG", 500);
      this.#origin = test.origin;
    } else if (this.mode === "mock") throw new MetaPublishingError("INVALID_PROVIDER_CONFIG", 500);
    this.#config = config; this.#now = config.now ?? (() => new Date());
  }
  authorizationUrl(state: string) {
    const url = new URL(`/${this.graphVersion}/dialog/oauth`, this.mode === "mock" ? this.#origin : "https://www.facebook.com");
    url.search = new URLSearchParams({client_id:this.#config.appId,config_id:this.#config.configId,
      redirect_uri:this.redirectUri,state:string(state,1024),response_type:"code",override_default_response_type:"true"}).toString();
    return url.href;
  }
  async exchangeCode(code: string, expectedProviderUserId?: string): Promise<VerifiedMetaPublishingGrant> {
    const short = await this.#request("oauth/access_token", undefined, {client_id:this.#config.appId,
      client_secret:this.#config.appSecret,redirect_uri:this.redirectUri,code:string(code)});
    const long = await this.#request("oauth/access_token", undefined, {grant_type:"fb_exchange_token",
      client_id:this.#config.appId,client_secret:this.#config.appSecret,fb_exchange_token:string(short.access_token)});
    const grant = await this.verifyToken(string(long.access_token), expectedProviderUserId);
    if (!Number.isSafeInteger(long.expires_in) || Number(long.expires_in) <= 0) return invalid();
    const responseExpiry = new Date(this.#now().getTime() + Number(long.expires_in)*1000);
    if (!Number.isFinite(responseExpiry.getTime())) return invalid();
    if (!grant.expiresAt || responseExpiry < grant.expiresAt) grant.expiresAt = responseExpiry;
    return grant;
  }
  async #debug(token: string, type: "USER" | "PAGE", subject?: string) {
    const result = object((await this.#request("debug_token", `${this.#config.appId}|${this.#config.appSecret}`, {input_token:string(token)})).data);
    if (result.is_valid !== true || String(result.app_id) !== this.#config.appId || result.type !== type)
      throw new MetaPublishingError("RECONNECT_REQUIRED",401,true);
    const userId = id(result.user_id);
    if (subject && subject !== userId) throw new MetaPublishingError("SUBJECT_MISMATCH",403,true);
    const scopes = list(result.scopes);
    if (this.scopes.some(scope => !scopes.includes(scope))) throw new MetaPublishingError("MISSING_PERMISSION",403,true);
    let expiresAt = expiry(result.expires_at);
    const dataAccessExpiresAt = result.data_access_expires_at === undefined ? null : expiry(result.data_access_expires_at);
    if (dataAccessExpiresAt && (!expiresAt || dataAccessExpiresAt < expiresAt)) expiresAt = dataAccessExpiresAt;
    if (expiresAt && expiresAt <= this.#now()) throw new MetaPublishingError("RECONNECT_REQUIRED",401,true);
    return {userId,scopes,expiresAt,dataAccessExpiresAt,granularScopes:result.granular_scopes};
  }
  async verifyToken(accessToken: string, expectedProviderUserId?: string): Promise<VerifiedMetaPublishingGrant> {
    const debug = await this.#debug(accessToken,"USER",expectedProviderUserId);
    const me = await this.#request("me",accessToken,{fields:"id,name"});
    if (id(me.id) !== debug.userId) throw new MetaPublishingError("SUBJECT_MISMATCH",403,true);
    return {accessToken,providerUserId:debug.userId,externalGrantId:debug.userId,displayName:string(me.name,512),
      tokenType:"USER",scopes:debug.scopes,expiresAt:debug.expiresAt,dataAccessExpiresAt:debug.dataAccessExpiresAt};
  }
  async discoverDestinations(userAccessToken: string, expectedProviderUserId?: string): Promise<{destinations:MetaSocialDestination[];pageCredentials:MetaPageCredential[]}> {
    await this.verifyToken(userAccessToken,expectedProviderUserId);
    return this.#discover(userAccessToken);
  }
  async #discover(userAccessToken: string): Promise<{destinations:MetaSocialDestination[];pageCredentials:MetaPageCredential[]}> {
    const destinations: MetaSocialDestination[] = [], pageCredentials: MetaPageCredential[] = [];
    const seen = new Set<string>(), seenIds = new Set<string>(); let after: string | undefined;
    for (let page=0; page<100; page++) {
      const result = await this.#request("me/accounts",userAccessToken,{fields:"id,name,tasks,access_token,instagram_business_account{id,username,name}",limit:"100",...(after ? {after} : {})});
      if (!Array.isArray(result.data) || result.data.length > 100) return invalid();
      for (const raw of result.data) {
        const row = object(raw), pageId = id(row.id), tasks = list(row.tasks);
        if (seenIds.has(pageId)) return invalid(); seenIds.add(pageId);
        const canPublish = tasks.some(task => task === "CREATE_CONTENT" || task === "MANAGE");
        const name = string(row.name,512);
        destinations.push({externalId:pageId,pageId,kind:"FACEBOOK_PAGE",name,tasks,canPublish});
        // Kept separate from all public destination metadata.
        if (canPublish && row.access_token !== undefined) pageCredentials.push({pageId,accessToken:string(row.access_token)});
        if (row.instagram_business_account !== undefined && row.instagram_business_account !== null) {
          const ig = object(row.instagram_business_account);
          destinations.push({externalId:id(ig.id),pageId,kind:"INSTAGRAM_PROFILE",name:typeof ig.name === "string" && ig.name ? string(ig.name,512) : `@${string(ig.username,512)}`,
            username:string(ig.username,512),tasks,canPublish});
        }
      }
      if (result.paging === undefined || object(result.paging).next === undefined) return {destinations,pageCredentials};
      const next = parseUrl(string(object(result.paging).next),this.#origin);
      if (next.origin !== this.#origin || next.pathname !== `/${this.graphVersion}/me/accounts` || next.username || next.password || next.hash) return invalid();
      after = next.searchParams.get("after") ?? undefined;
      if (!after || after.length > 4096 || seen.has(after)) return invalid(); seen.add(after);
    }
    return invalid();
  }
  async verifyTarget(userAccessToken: string, credential: MetaPageCredential,
    kind: MetaPublishingKind, externalId: string, expectedUserId?: string): Promise<VerifiedMetaPublishingTarget> {
    const user = await this.verifyToken(userAccessToken,expectedUserId);
    const discovered = await this.#discover(userAccessToken);
    const target = discovered.destinations.find(d => d.kind === kind && d.externalId === id(externalId) && d.pageId === id(credential.pageId));
    if (!target || !target.canPublish) throw new MetaPublishingError("TARGET_UNAVAILABLE",403,true);
    const page = await this.#debug(credential.accessToken,"PAGE",user.providerUserId);
    if (page.granularScopes !== undefined) {
      if (!Array.isArray(page.granularScopes)) return invalid();
      for (const raw of page.granularScopes) {
        const item = object(raw);
        if (this.scopes.includes(item.scope as typeof META_PUBLISHING_SCOPES[number]) && item.target_ids !== undefined &&
          !list(item.target_ids).some(value => value === target.pageId || value === target.externalId))
          throw new MetaPublishingError("TARGET_UNAVAILABLE",403,true);
      }
    }
    const me = await this.#request("me",credential.accessToken,{fields:"id,name"});
    if (id(me.id) !== target.pageId) throw new MetaPublishingError("TARGET_MISMATCH",403,true);
    const proof = Object.freeze({...target,tasks:[...target.tasks]}); this.#credentials.set(proof,{accessToken:credential.accessToken,expiresAt:page.expiresAt}); return proof;
  }
  #token(target: VerifiedMetaPublishingTarget) {
    const credential = this.#credentials.get(target); if (!credential) throw new MetaPublishingError("UNVERIFIED_TARGET",403,true);
    if (credential.expiresAt && credential.expiresAt <= this.#now()) throw new MetaPublishingError("RECONNECT_REQUIRED",401,true);
    return credential.accessToken;
  }
  async #quota(target: VerifiedMetaPublishingTarget) {
    if (target.kind !== "INSTAGRAM_PROFILE") return;
    const result = await this.#request(`${target.externalId}/content_publishing_limit`,this.#token(target),{fields:"config,quota_usage"});
    if (!Array.isArray(result.data) || result.data.length !== 1) return invalid();
    const row = object(result.data[0]), config = object(row.config);
    if (![row.quota_usage,config.quota_total,config.quota_duration].every(Number.isSafeInteger) ||
      Number(row.quota_usage)<0 || Number(config.quota_total)<=0 || Number(config.quota_duration)<=0) return invalid();
    if (Number(row.quota_usage)>=Number(config.quota_total)) throw new MetaPublishingError("RATE_LIMIT",429,true,60_000);
  }
  async createPhoto(target: VerifiedMetaPublishingTarget, url: string) {
    if (target.kind !== "FACEBOOK_PAGE") throw new MetaPublishingError("INVALID_FORMAT",400,true);
    return id((await this.#request(`${target.externalId}/photos`,this.#token(target),{},"POST",{url,published:"false"})).id);
  }
  async publishFeed(target: VerifiedMetaPublishingTarget, message: string, photoId?: string) {
    if (target.kind !== "FACEBOOK_PAGE") throw new MetaPublishingError("INVALID_FORMAT",400,true);
    const data = await this.#request(`${target.externalId}/feed`,this.#token(target),{},"POST",{message,published:"true",
      ...(photoId ? {"attached_media[0]":JSON.stringify({media_fbid:id(photoId)})} : {})});
    const postId = string(data.id,130);
    if (!new RegExp(`^${target.pageId}_\\d{1,64}$`).test(postId)) return invalid(); return postId;
  }
  async startReel(target: VerifiedMetaPublishingTarget) {
    if (target.kind !== "FACEBOOK_PAGE") throw new MetaPublishingError("INVALID_FORMAT",400,true);
    const result = await this.#request(`${target.externalId}/video_reels`,this.#token(target),{},"POST",{upload_phase:"start"});
    const videoId = id(result.video_id), uploadUrl = parseUrl(string(result.upload_url));
    const expectedOrigin = this.mode === "mock" ? this.#origin : "https://rupload.facebook.com";
    if (uploadUrl.origin !== expectedOrigin || uploadUrl.username || uploadUrl.password || uploadUrl.hash || uploadUrl.search ||
      uploadUrl.pathname !== `/video-upload/${this.graphVersion}/${videoId}`) return invalid();
    return {videoId,uploadUrl:uploadUrl.href};
  }
  async uploadReel(target: VerifiedMetaPublishingTarget, videoId: string, uploadUrl: string, mediaUrl: string) {
    const expected = this.mode === "mock" ? this.#origin : "https://rupload.facebook.com";
    const url = parseUrl(uploadUrl);
    if (url.origin !== expected || url.pathname !== `/video-upload/${this.graphVersion}/${id(videoId)}` || url.search || url.hash || url.username || url.password) return invalid();
    const result = await this.#http(url,this.#token(target),"POST",undefined,{Authorization:`OAuth ${this.#token(target)}`,file_url:mediaUrl});
    if (result.success !== true) return invalid();
  }
  async reelStatus(target: VerifiedMetaPublishingTarget, videoId: string): Promise<"READY"|"PUBLISHED"|"PROCESSING"|"ERROR"> {
    const result = await this.#request(id(videoId),this.#token(target),{fields:"id,status"});
    if (id(result.id) !== videoId) return invalid();
    const status = object(result.status), upload = object(status.uploading_phase), process = object(status.processing_phase), publish = object(status.publishing_phase);
    if ([upload.status,process.status,publish.status].some(v => v === "error") || status.video_status === "error") return "ERROR";
    if (publish.status === "complete") return "PUBLISHED";
    if (upload.status === "complete" && process.status === "complete") return "READY";
    return "PROCESSING";
  }
  async finishReel(target: VerifiedMetaPublishingTarget, videoId: string, description: string, title: string, isAigc?: boolean) {
    const result = await this.#request(`${target.externalId}/video_reels`,this.#token(target),{},"POST",{video_id:id(videoId),upload_phase:"finish",video_state:"PUBLISHED",description,title,
      ...(isAigc === undefined ? {} : {is_ai_generated:String(isAigc)})});
    if (result.success !== true) return invalid();
  }
  async createContainer(target: VerifiedMetaPublishingTarget, format: "IMAGE"|"SHORT_VIDEO", mediaUrl: string, caption: string, shareToFeed?: boolean) {
    if (target.kind !== "INSTAGRAM_PROFILE") throw new MetaPublishingError("INVALID_FORMAT",400,true);
    await this.#quota(target);
    if (format === "SHORT_VIDEO" && typeof shareToFeed !== "boolean") throw new MetaPublishingError("INVALID_FORMAT",400,true);
    return id((await this.#request(`${target.externalId}/media`,this.#token(target),{},"POST",format === "IMAGE" ?
      {image_url:mediaUrl,caption} : {media_type:"REELS",video_url:mediaUrl,caption,share_to_feed:String(shareToFeed)})).id);
  }
  async containerStatus(target: VerifiedMetaPublishingTarget, containerId: string): Promise<"FINISHED"|"IN_PROGRESS"|"PUBLISHED"|"ERROR"|"EXPIRED"> {
    const result = await this.#request(id(containerId),this.#token(target),{fields:"id,status_code,status"});
    if (id(result.id) !== containerId || !["FINISHED","IN_PROGRESS","PUBLISHED","ERROR","EXPIRED"].includes(String(result.status_code))) return invalid();
    return result.status_code as "FINISHED"|"IN_PROGRESS"|"PUBLISHED"|"ERROR"|"EXPIRED";
  }
  async publishContainer(target: VerifiedMetaPublishingTarget, containerId: string) {
    if (await this.containerStatus(target,containerId) !== "FINISHED") throw new MetaPublishingError("CONTAINER_NOT_READY",409,true);
    await this.#quota(target);
    return id((await this.#request(`${target.externalId}/media_publish`,this.#token(target),{},"POST",{creation_id:id(containerId)})).id);
  }
  async publishedStatus(target: VerifiedMetaPublishingTarget, externalId: string): Promise<{published:boolean;externalId:string;publishUrl?:string}> {
    if (target.kind === "FACEBOOK_PAGE") {
      if (!new RegExp(`^${target.pageId}_\\d{1,64}$`).test(externalId)) return invalid();
      const result = await this.#request(externalId,this.#token(target),{fields:"id,is_published,permalink_url,from{id}"});
      if (result.id !== externalId || id(object(result.from).id) !== target.pageId || typeof result.is_published !== "boolean") return invalid();
      return {published:result.is_published,externalId,...this.#permalink(result.permalink_url,"facebook.com")};
    }
    const result = await this.#request(id(externalId),this.#token(target),{fields:"id,owner,permalink"});
    const owner = typeof result.owner === "string" ? result.owner : object(result.owner).id;
    if (id(result.id) !== externalId || id(owner) !== target.externalId) throw new MetaPublishingError("TARGET_MISMATCH",403,true);
    return {published:true,externalId,...this.#permalink(result.permalink,"instagram.com")};
  }
  #permalink(value: unknown, domain: string): {publishUrl?:string} {
    if (value === undefined) return {};
    const url = parseUrl(string(value,4096));
    if (url.protocol !== "https:" || url.username || url.password || url.hash || !(url.hostname === domain || url.hostname === `www.${domain}`)) return invalid();
    return {publishUrl:url.href};
  }
  async #request(path: string, token?: string, query: Record<string,string> = {}, method: "GET"|"POST" = "GET", body?: Record<string,string>) {
    const url = new URL(`/${this.graphVersion}/${path}`,this.#origin); url.search = new URLSearchParams(query).toString();
    if (token) url.searchParams.set("appsecret_proof",createHmac("sha256",this.#config.appSecret).update(token).digest("hex"));
    return this.#http(url,token,method,body);
  }
  async #http(url: URL, token: string|undefined, method: "GET"|"POST", body?: Record<string,string>, extra: Record<string,string> = {}) {
    await this.#config.beforeRequest?.();
    let response: Response;
    try { response = await fetch(url,{method,redirect:"error",signal:AbortSignal.timeout(15_000),headers:{Accept:"application/json",
      ...(token ? {Authorization:`Bearer ${token}`} : {}),...(body ? {"Content-Type":"application/x-www-form-urlencoded"} : {}),...extra},
      body:body ? new URLSearchParams(body).toString() : undefined}); }
    catch { throw new MetaPublishingError("NETWORK_ERROR",502,method === "GET"); }
    let raw: string;
    try {
      const reader = response.body?.getReader(), chunks:Uint8Array[]=[]; let size=0;
      if (!reader) return invalid();
      while (true) { const {done,value}=await reader.read(); if (done) break; size+=value.byteLength;
        if (size > 1_048_576) { await reader.cancel(); return invalid(); } chunks.push(value); }
      raw=Buffer.concat(chunks).toString("utf8");
    } catch (error) { if (error instanceof MetaPublishingError) throw error; throw new MetaPublishingError("NETWORK_ERROR",502,method === "GET"); }
    let result: Json; try { result = object(JSON.parse(raw)); } catch { return invalid(); }
    if (!response.ok || result.error) {
      const error = result.error && typeof result.error === "object" ? object(result.error) : {};
      const code = Number(error.code), rate = response.status === 429 || [4,17,32,613,80004].includes(code);
      const transient = response.status >= 500 || error.is_transient === true;
      const seconds = Number(response.headers.get("retry-after"));
      const retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds*1000,86_400_000) : undefined;
      throw new MetaPublishingError(code === 190 ? "RECONNECT_REQUIRED" : [10,200].includes(code) ? "MISSING_PERMISSION" : rate ? "RATE_LIMIT" : transient ? "TRANSIENT" : "PROVIDER_REJECTED",
        code === 190 ? 401 : [10,200].includes(code) ? 403 : rate ? 429 : 502,
        // Reads cannot publish. Server/transient submission failures may be accepted and remain ambiguous.
        method === "GET" || (Boolean(result.error) && !transient),retryAfterMs);
    }
    return result;
  }
}
