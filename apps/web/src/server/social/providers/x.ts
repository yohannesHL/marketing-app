import {
  XClient,
  XError,
  X_CHUNK_BYTES,
  X_SCOPES,
  validateXText,
  validateXMedia,
  xCostEstimate,
  xContentDigest,
  type XConfig,
  type XMedia,
  type XMediaReceipt,
  type XPriceSchedule,
} from "../../providers/x";
import { fail } from "../../security/errors";
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

export type XMediaConfig = {
  mediaOrigin: string;
  prices: XPriceSchedule;
  maxBytes?: number;
  now?: () => Date;
  mediaTimeoutMs?: number;
};
type AssetProgress = {
  assetId: string;
  bytes: number;
  mime: string;
  nextSegment: number;
  finalized: boolean;
  ready: boolean;
  id?: string;
  key?: string;
  expiresAt?: string;
  pollAfter?: string;
};
type Progress = {
  provider: "x";
  revisionId: string;
  userId: string;
  authorizationId: string;
  authorizationGeneration: number;
  contentDigest: string;
  media: AssetProgress[];
  createAttempted: boolean;
  postId?: string;
  deleteAccepted?: boolean;
};
const operations = [
  "USER_READ",
  "POST_READ",
  "POST_CREATE",
  "POST_CREATE_URL",
  "POST_DELETE",
  "MEDIA_UPLOAD",
  "MEDIA_INIT",
  "MEDIA_APPEND",
  "MEDIA_FINALIZE",
  "MEDIA_STATUS",
] as const;
function controls(
  content: SocialProviderContext["content"],
  media: readonly XMedia[],
  config: XMediaConfig,
) {
  const o = content.providerOptions;
  if (
    Object.keys(o).some(
      (key) =>
        !["madeWithAi", "paidPartnership", "maxApiCostMicros"].includes(key),
    ) ||
    typeof o.madeWithAi !== "boolean" ||
    typeof o.paidPartnership !== "boolean" ||
    !(typeof o.maxApiCostMicros === "number"
      ? Number.isSafeInteger(o.maxApiCostMicros)
      : typeof o.maxApiCostMicros === "string" &&
        /^\d{1,15}$/.test(o.maxApiCostMicros)) ||
    Number(o.maxApiCostMicros) < 0 ||
    !Number.isSafeInteger(Number(o.maxApiCostMicros))
  )
    fail(
      "INVALID_PROVIDER_OPTIONS",
      400,
      "Review X AI and partnership disclosures and approve an API cost ceiling.",
    );
  if (
    (content.format === "TEXT" && media.length) ||
    (content.format === "IMAGE" && (!media.length || media.length > 4)) ||
    (content.format === "SHORT_VIDEO" && media.length !== 1)
  )
    fail(
      "UNSUPPORTED_CONTENT",
      400,
      "Choose text, up to four images or one video for X.",
    );
  try {
    validateXText(content.body, media.length);
    for (const asset of media)
      validateXMedia(asset, content.format as "IMAGE" | "SHORT_VIDEO");
  } catch {
    fail(
      "UNSUPPORTED_CONTENT",
      400,
      "Review the weighted 280-character text and inspected X media.",
    );
  }
  const estimatedCostMicros = xCostEstimate(
      content.body,
      content.format,
      media,
      config.prices,
    ),
    maxApiCostMicros = Number(o.maxApiCostMicros);
  if (estimatedCostMicros > maxApiCostMicros)
    fail(
      "API_COST_LIMIT",
      409,
      "The X API estimate exceeds this reviewed cost ceiling.",
    );
  return {
    madeWithAi: o.madeWithAi as boolean,
    paidPartnership: o.paidPartnership as boolean,
    maxApiCostMicros,
    estimatedCostMicros,
  };
}
function saved(value: SocialProgress): Progress | undefined {
  if (!Object.keys(value).length) return;
  const id = (v: unknown) => typeof v === "string" && /^[0-9]{1,19}$/.test(v);
  const date = (v: unknown) =>
    v === undefined ||
    (typeof v === "string" && Number.isFinite(Date.parse(v)));
  if (
    value.provider !== "x" ||
    typeof value.revisionId !== "string" ||
    !id(value.userId) ||
    typeof value.authorizationId !== "string" ||
    !Number.isSafeInteger(value.authorizationGeneration) ||
    Number(value.authorizationGeneration) < 1 ||
    typeof value.contentDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.contentDigest) ||
    typeof value.createAttempted !== "boolean" ||
    (value.postId !== undefined && !id(value.postId)) ||
    (value.deleteAccepted !== undefined && value.deleteAccepted !== true) ||
    (value.deleteAccepted === true && !id(value.postId)) ||
    !Array.isArray(value.media) ||
    value.media.length > 4 ||
    value.media.some(
      (m) =>
        !m ||
        typeof m !== "object" ||
        typeof m.assetId !== "string" ||
        !Number.isSafeInteger(m.bytes) ||
        m.bytes < 1 ||
        typeof m.mime !== "string" ||
        !Number.isSafeInteger(m.nextSegment) ||
        m.nextSegment < 0 ||
        m.nextSegment > 9999 ||
        typeof m.finalized !== "boolean" ||
        typeof m.ready !== "boolean" ||
        (m.id !== undefined && !id(m.id)) ||
        (m.key !== undefined &&
          (typeof m.key !== "string" || !/^\d{1,3}_\d{1,19}$/.test(m.key))) ||
        !date(m.expiresAt) ||
        !date(m.pollAfter) ||
        Object.keys(m).some(
          (k) =>
            ![
              "assetId",
              "bytes",
              "mime",
              "nextSegment",
              "finalized",
              "ready",
              "id",
              "key",
              "expiresAt",
              "pollAfter",
            ].includes(k),
        ),
    ) ||
    Object.keys(value).some(
      (k) =>
        ![
          "provider",
          "revisionId",
          "userId",
          "authorizationId",
          "authorizationGeneration",
          "contentDigest",
          "media",
          "createAttempted",
          "postId",
          "deleteAccepted",
        ].includes(k),
    )
  )
    fail(
      "INVALID_PROVIDER_PROGRESS",
      502,
      "The saved X delivery evidence is unavailable.",
    );
  return structuredClone(value) as Progress;
}
/** Only post creation crosses PUBLISH. Media preparation cannot create a customer post. */
export class XSocialProvider implements SocialProvider {
  private readonly mode: "mock" | "live";
  private readonly now: () => Date;
  private readonly mediaOrigin: string;
  private readonly maxBytes: number;
  private readonly timeout: number;
  constructor(
    private readonly config: XConfig,
    private readonly mediaConfig: XMediaConfig,
  ) {
    this.mode = new XClient(config).mode;
    this.now = mediaConfig.now ?? config.now ?? (() => new Date());
    let origin: URL;
    try {
      origin = new URL(mediaConfig.mediaOrigin);
    } catch {
      fail("INVALID_CONFIG", 503, "Configure the owned X media origin.");
    }
    if (
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      !(
        origin.protocol === "https:" ||
        (this.mode === "mock" &&
          origin.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
      )
    )
      fail("INVALID_CONFIG", 503, "Configure the owned X media origin.");
    this.mediaOrigin = origin.origin;
    this.maxBytes = mediaConfig.maxBytes ?? 64 * 1024 * 1024;
    this.timeout = mediaConfig.mediaTimeoutMs ?? 20000;
    if (
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes < 1 ||
      this.maxBytes > 512 * 1024 * 1024 ||
      !Number.isSafeInteger(this.timeout) ||
      this.timeout < 1 ||
      this.timeout > 60000 ||
      operations.some(
        (op) =>
          !Number.isSafeInteger(mediaConfig.prices?.[op]) ||
          mediaConfig.prices[op] < 0,
      )
    )
      fail(
        "INVALID_CONFIG",
        503,
        "Configure explicit X endpoint price bounds and media limits.",
      );
  }
  private binding(
    context: SocialProviderContext,
    call: SocialProviderCall,
    progress?: Progress,
  ) {
    if (call.mode !== this.mode)
      fail(
        "CONNECTION_MODE_MISMATCH",
        409,
        "Choose an X connection for this environment.",
      );
    if (
      call.destination.kind !== "X_PROFILE" ||
      !call.providerUserId ||
      call.providerUserId !== call.destination.externalId ||
      !call.authorizationId ||
      !Number.isSafeInteger(call.authorizationGeneration) ||
      Number(call.authorizationGeneration) < 1
    )
      fail(
        "INVALID_SELECTION",
        409,
        "Choose the profile belonging to this verified X authorization.",
      );
    const options = controls(context.content, call.media, this.mediaConfig);
    if (call.media.some((m) => m.bytes > this.maxBytes))
      fail(
        "MEDIA_UNAVAILABLE",
        413,
        "This asset exceeds the configured X delivery size limit.",
      );
    if (!call.authorizeApiCost)
      fail(
        "API_COST_APPROVAL_REQUIRED",
        503,
        "X publishing requires durable API budget approval.",
      );
    if (
      progress &&
      (progress.revisionId !== context.revisionId ||
        progress.userId !== call.destination.externalId ||
        progress.authorizationId !== call.authorizationId ||
        progress.authorizationGeneration !== call.authorizationGeneration ||
        progress.contentDigest !==
          xContentDigest(
            context.content.body,
            context.content.providerOptions,
          ) ||
        progress.media.length !== call.media.length ||
        progress.media.some(
          (m, i) =>
            m.assetId !== call.media[i].id ||
            m.bytes !== call.media[i].bytes ||
            m.mime !== call.media[i].mime,
        ))
    )
      fail(
        "INVALID_PROVIDER_PROGRESS",
        502,
        "The saved X progress does not belong to this reviewed account and content.",
      );
    return {
      options,
      client: new XClient({
        ...this.config,
        beforeRequest: call.verifyCurrent,
        beforeBillableRequest: (operation) =>
          call.authorizeApiCost!({
            operation,
            costMicros: this.mediaConfig.prices[operation],
            maxApiCostMicros: options.maxApiCostMicros,
          }),
      }),
    };
  }
  private async classified<T>(
    work: () => Promise<T>,
    afterCreate = false,
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof XError)) throw error;
      if (
        [
          "RECONNECT_REQUIRED",
          "MISSING_PERMISSION",
          "PROVIDER_IDENTITY_MISMATCH",
          "PROVIDER_CREDITS_REQUIRED",
        ].includes(error.code)
      )
        throw error;
      if (afterCreate || error.outcomeUnknown)
        throw new SocialProviderFailure("TRANSIENT", false, error.retryAfterMs);
      if (error.code === "PROVIDER_RATE_LIMITED")
        throw new SocialProviderFailure("RATE_LIMIT", true, error.retryAfterMs);
      if (error.retryable)
        throw new SocialProviderFailure("TRANSIENT", true, error.retryAfterMs);
      throw new SocialProviderFailure("TERMINAL", true);
    }
  }
  async validate(context: SocialProviderContext) {
    await context.rpc("PREPARE", async (call) => {
      const { client } = this.binding(context, call);
      await this.classified(() =>
        client.verifiedUser(call.accessToken, call.destination.externalId),
      );
    });
  }
  async prepare(
    context: SocialProviderContext,
    value: SocialProgress,
  ): Promise<SocialProgress> {
    let progress = saved(value);
    await context.rpc("PREPARE", async (call) => {
      const { client } = this.binding(context, call, progress);
      await this.classified(() =>
        client.verifiedUser(call.accessToken, call.destination.externalId),
      );
      progress ??= {
        provider: "x",
        revisionId: context.revisionId,
        userId: call.destination.externalId,
        authorizationId: call.authorizationId!,
        authorizationGeneration: call.authorizationGeneration!,
        contentDigest: xContentDigest(
          context.content.body,
          context.content.providerOptions,
        ),
        createAttempted: false,
        media: call.media.map((m) => ({
          assetId: m.id,
          mime: m.mime,
          bytes: m.bytes,
          nextSegment: 0,
          finalized: false,
          ready: false,
        })),
      };
    });
    const p = progress!;
    if (p.createAttempted) return p;
    for (let i = 0; i < p.media.length; i++) {
      const m = p.media[i];
      if (
        m.expiresAt &&
        Date.parse(m.expiresAt) <= this.now().getTime() + 60000
      ) {
        // An expired upload is never reused; no post-creation boundary has been crossed.
        p.media[i] = {
          assetId: m.assetId,
          bytes: m.bytes,
          mime: m.mime,
          nextSegment: 0,
          finalized: false,
          ready: false,
        };
      }
      const entry = p.media[i];
      if (!entry.ready) await this.upload(context, p, i);
    }
    return p;
  }
  private update(entry: AssetProgress, receipt: XMediaReceipt) {
    if (entry.id && entry.id !== receipt.id)
      fail(
        "INVALID_PROVIDER_PROGRESS",
        502,
        "The X media receipt changed identity.",
      );
    entry.id = receipt.id;
    if (receipt.mediaKey) entry.key = receipt.mediaKey;
    if (receipt.expiresAt) {
      // Never extend the original expiry from a status response.
      entry.expiresAt = new Date(
        Math.min(
          receipt.expiresAt.getTime(),
          entry.expiresAt ? Date.parse(entry.expiresAt) : Infinity,
        ),
      ).toISOString();
    }
    entry.ready = receipt.state === "succeeded";
    entry.pollAfter = new Date(
      this.now().getTime() + receipt.checkAfterMs,
    ).toISOString();
  }
  private async upload(
    context: SocialProviderContext,
    p: Progress,
    index: number,
  ) {
    const entry = p.media[index];
    await context.rpc("UPLOAD", async (call) => {
      const { client } = this.binding(context, call, p),
        asset = call.media[index];
      if (entry.id && entry.finalized) {
        if (
          entry.pollAfter &&
          Date.parse(entry.pollAfter) > this.now().getTime()
        )
          throw new SocialProviderFailure(
            "TRANSIENT",
            true,
            Date.parse(entry.pollAfter) - this.now().getTime(),
          );
        const receipt = await this.classified(() =>
          client.mediaStatus(call.accessToken, entry.id!),
        );
        this.update(entry, receipt);
        await context.checkpoint({ ...p });
        if (receipt.state === "failed")
          throw new SocialProviderFailure("TERMINAL", true);
        if (!entry.ready)
          throw new SocialProviderFailure(
            "TRANSIENT",
            true,
            receipt.checkAfterMs,
          );
        return;
      }
      const bytes = await this.loadMedia(call, asset);
      if (context.content.format === "IMAGE") {
        const receipt = await this.classified(() =>
          client.uploadImage(call.accessToken, asset, bytes),
        );
        this.update(entry, receipt);
        entry.finalized = true;
        await context.checkpoint({ ...p });
        if (receipt.state === "failed")
          throw new SocialProviderFailure("TERMINAL", true);
        if (!entry.ready)
          throw new SocialProviderFailure(
            "TRANSIENT",
            true,
            receipt.checkAfterMs,
          );
        return;
      }
      if (!entry.id) {
        const receipt = await this.classified(() =>
          client.initVideo(call.accessToken, asset),
        );
        this.update(entry, receipt);
        entry.ready = false;
        await context.checkpoint({ ...p });
      }
      const segments = Math.ceil(bytes.byteLength / X_CHUNK_BYTES);
      if (entry.nextSegment > segments)
        fail(
          "INVALID_PROVIDER_PROGRESS",
          502,
          "The X upload acknowledgement exceeds this video.",
        );
      while (entry.nextSegment < segments) {
        const segment = entry.nextSegment;
        await this.classified(() =>
          client.appendVideo(
            call.accessToken,
            entry.id!,
            segment,
            bytes.subarray(
              segment * X_CHUNK_BYTES,
              (segment + 1) * X_CHUNK_BYTES,
            ),
          ),
        );
        entry.nextSegment++;
        await context.checkpoint({ ...p });
      }
      const receipt = await this.classified(() =>
        client.finalizeVideo(call.accessToken, entry.id!),
      );
      this.update(entry, receipt);
      entry.finalized = true;
      await context.checkpoint({ ...p });
      if (receipt.state === "failed")
        throw new SocialProviderFailure("TERMINAL", true);
      if (!entry.ready)
        throw new SocialProviderFailure(
          "TRANSIENT",
          true,
          receipt.checkAfterMs,
        );
    });
  }
  async publish(
    context: SocialProviderContext,
    value: SocialProgress,
  ): Promise<SocialPublished> {
    const p = saved(value);
    if (!p)
      fail(
        "INVALID_PROVIDER_PROGRESS",
        502,
        "Prepare the reviewed X post before publishing.",
      );
    if (!p.postId) {
      if (p.createAttempted)
        throw new SocialProviderFailure("TRANSIENT", false);
      await context.rpc("PREPARE", async (call) => {
        const { client } = this.binding(context, call, p);
        if (
          p.media.some(
            (m) =>
              !m.id ||
              !m.ready ||
              !m.finalized ||
              !m.expiresAt ||
              Date.parse(m.expiresAt) <= this.now().getTime() + 60000,
          )
        )
          fail(
            "MEDIA_UNAVAILABLE",
            409,
            "Wait for current X media processing or refresh expired uploads.",
          );
        await this.classified(() =>
          client.verifiedUser(call.accessToken, p.userId),
        );
      });
      p.createAttempted = true;
      await context.checkpoint({ ...p });
      const receipt = await context.rpc("PUBLISH", async (call) => {
        const { client, options } = this.binding(context, call, p);
        try {
          return await client.createPost(call.accessToken, {
            text: context.content.body,
            mediaIds: p.media.map((m) => m.id!),
            madeWithAi: options.madeWithAi,
            paidPartnership: options.paidPartnership,
          });
        } catch (error) {
          // Classify the actual submission failure inside its RPC boundary.
          // A later read/checkpoint failure cannot prove a rejected create.
          if (error instanceof XError && !error.outcomeUnknown) {
            p.createAttempted = false;
            await context.checkpoint({ ...p });
          }
          return this.classified(async () => {
            throw error;
          });
        }
      });
      p.postId = receipt.id;
      await context.checkpoint({ ...p });
    }
    return context.rpc("PROCESS", async (call) => {
      const { client } = this.binding(context, call, p),
        result = await this.classified(
          () => client.post(call.accessToken, p.postId!, p.userId),
          true,
        );
      return this.confirmed(context, p, result);
    });
  }
  private confirmed(
    context: SocialProviderContext,
    p: Progress,
    post: Awaited<ReturnType<XClient["post"]>>,
  ) {
    // X may rewrite URLs to t.co; a known receipt and verified author are the publication proof.
    if (
      post.mediaKeys.length !== p.media.length ||
      p.media.some(
        (m) =>
          !post.mediaKeys.some((key) =>
            m.key ? key === m.key : key.endsWith(`_${m.id}`),
          ),
      ) ||
      (!validateXText(context.content.body, p.media.length).hasUrls &&
        post.text.normalize("NFC") !== context.content.body.normalize("NFC"))
    )
      fail(
        "PUBLICATION_UNVERIFIED",
        502,
        "X returned a post that does not match the reviewed publication evidence.",
      );
    return {
      externalId: post.id,
      publishUrl: `https://x.com/i/web/status/${post.id}`,
    };
  }
  async status(
    context: SocialProviderContext,
    value: SocialProgress,
  ): Promise<SocialStatusResult> {
    const p = saved(value);
    if (!p || (p.createAttempted && !p.postId)) return { status: "UNKNOWN" };
    if (!p.postId) return { status: "NOT_PUBLISHED" };
    return context.rpc("PROCESS", async (call) => {
      const { client } = this.binding(context, call, p);
      try {
        const post = await client.post(call.accessToken, p.postId!, p.userId);
        return {
          status: "PUBLISHED",
          result: this.confirmed(context, p, post),
        };
      } catch (error) {
        if (error instanceof XError && error.code === "POST_NOT_FOUND")
          return { status: p.deleteAccepted ? "NOT_PUBLISHED" : "UNKNOWN" };
        return this.classified(async () => {
          throw error;
        }, true);
      }
    });
  }
  async cancel(context: SocialProviderContext, value: SocialProgress) {
    const p = saved(value);
    if (!p) return { cancelled: true };
    if (!p.postId) return { cancelled: !p.createAttempted };
    return context.rpc("PROCESS", async (call) => {
      const { client } = this.binding(context, call, p);
      if (p.deleteAccepted) {
        try {
          await client.post(call.accessToken, p.postId!, p.userId);
          return { cancelled: false };
        } catch (error) {
          if (error instanceof XError && error.code === "POST_NOT_FOUND")
            return { cancelled: true };
          throw error;
        }
      }
      const existing = await this.classified(
        () => client.post(call.accessToken, p.postId!, p.userId),
        true,
      );
      this.confirmed(context, p, existing);
      await this.classified(
        () => client.deletePost(call.accessToken, p.postId!),
        true,
      );
      p.deleteAccepted = true;
      await context.checkpoint({ ...p });
      try {
        await client.post(call.accessToken, p.postId!, p.userId);
        return { cancelled: false };
      } catch (error) {
        if (error instanceof XError && error.code === "POST_NOT_FOUND")
          return { cancelled: true };
        throw error;
      }
    });
  }
  private async loadMedia(
    call: SocialProviderCall,
    asset: SocialProviderCall["media"][number],
  ) {
    let url: URL;
    try {
      url = new URL(asset.url);
    } catch {
      fail("MEDIA_UNAVAILABLE", 409, "The owned X media URL is unavailable.");
    }
    if (
      url.origin !== this.mediaOrigin ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== `/api/social/media/${asset.id}/content` ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(asset.id) ||
      [...url.searchParams.keys()].length !== 2 ||
      url.searchParams.getAll("signature").length !== 1 ||
      url.searchParams.getAll("expires").length !== 1 ||
      !/^[a-f0-9]{64}$/.test(url.searchParams.get("signature") ?? "") ||
      !/^\d{10}$/.test(url.searchParams.get("expires") ?? "") ||
      Number(url.searchParams.get("expires")) * 1000 <= this.now().getTime()
    )
      fail(
        "MEDIA_UNAVAILABLE",
        409,
        "Choose the owned current signed X media URL.",
      );
    await call.verifyCurrent();
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeout),
      });
    } catch {
      throw new SocialProviderFailure("TRANSIENT", true);
    }
    if (
      response.status !== 200 ||
      response.headers.get("content-type")?.split(";")[0] !== asset.mime ||
      response.headers.get("content-length") !== String(asset.bytes) ||
      !response.body
    ) {
      await response.body?.cancel();
      fail(
        "MEDIA_UNAVAILABLE",
        409,
        "The reviewed X media changed, redirected or expired.",
      );
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > asset.bytes || size > this.maxBytes) {
          await reader.cancel();
          fail(
            "MEDIA_UNAVAILABLE",
            413,
            "The X media download exceeds its inspected size.",
          );
        }
        chunks.push(part.value);
      }
    } catch (error) {
      if (error instanceof Error && "code" in error) throw error;
      throw new SocialProviderFailure("TRANSIENT", true);
    }
    if (size !== asset.bytes)
      fail("MEDIA_UNAVAILABLE", 409, "The X media download is incomplete.");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
}
export function xSocialRegistration(
  config: XConfig,
  media: XMediaConfig,
): SocialProviderRegistration {
  // Validate configuration once before exposing publishing readiness.
  new XSocialProvider(config, media);
  return {
    platform: "X",
    kind: "X_PROFILE",
    modes: [config.mockoonBaseUrl ? "mock" : "live"],
    requiredScopes: [...X_SCOPES],
    formats: ["TEXT", "IMAGE", "SHORT_VIDEO"],
    mediaFetchWindowMs: 60000,
    renewableCredentials: true,
    validateContent: (content, assets) =>
      controls(
        content,
        assets.map((asset) => ({ ...asset, url: "" })),
        media,
      ),
    factory: () => new XSocialProvider(config, media),
  };
}
