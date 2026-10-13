import type { PrismaClient, Prisma } from "../../generated/prisma/client";
import { CustomerAuth, digest, type CustomerPrincipal } from "../auth/customerAuth";
import { fail } from "../security/errors";
import { SocialProviderRegistry, type SocialDraftInput, type SocialScheduleInput, type SocialWorkerConfig } from "./types";
import { aggregateSocialPostStatus } from "./aggregate";
import { draft, identifiers, ownedDestination, schedule, verifyFormat, verifyMedia } from "./validation";

type Tx = Prisma.TransactionClient;
const pending = ["QUEUED", "LEASED", "RETRY_WAIT", "BLOCKED", "FAILED"] as const;
export class SocialPostService {
  constructor(private readonly db: PrismaClient, private readonly auth: CustomerAuth,
    readonly config: SocialWorkerConfig, readonly registry = new SocialProviderRegistry(), private readonly now = () => new Date()) {}

  private enabled(platform: string, kind: string) {
    const registration = this.registry.get(platform as never, kind as never);
    return Boolean(this.config.writesEnabled && this.config.approvedProviders.includes(`${platform}:${kind}`) && registration?.modes.includes(this.config.mode));
  }
  private async session(tx: Tx, principal: CustomerPrincipal) {
    if (!await tx.customerSession.findFirst({ where: { id: principal.sessionId, userId: principal.userId, expiresAt: { gt: this.now() } } }))
      fail("UNAUTHENTICATED", 401, "Sign in to continue.");
  }
  private async owned(tx: Tx, principal: CustomerPrincipal, id: string) {
    const post = await tx.socialPost.findFirst({ where: { id, ownerId: principal.userId }, include: { revisions: { orderBy: { number: "desc" } } } });
    if (!post) fail("NOT_FOUND", 404, "Social post not found.");
    return post;
  }
  private async verifiedDraft(tx: Tx, ownerId: string, input: SocialDraftInput) {
    draft(input);
    const media = await tx.socialMediaAsset.findMany({ where: { id: { in: input.mediaIds }, ownerId } });
    verifyMedia(media, ownerId, input.mediaIds, this.now());
    for (const variant of input.variants) {
      const destination = await ownedDestination(tx, ownerId, variant.destinationId, this.config.mode, this.now());
      const variantMedia = (variant.mediaIds ?? input.mediaIds).map((id) => media.find((m) => m.id === id)!);
      verifyFormat(variant.format, destination.kind, variantMedia);
    }
    return input;
  }
  private async addRevision(tx: Tx, postId: string, number: number, input: SocialDraftInput) {
    return tx.socialPostRevision.create({ data: { postId, number, title: input.title.trim(), body: input.body,
      contentDigest: digest(JSON.stringify(input)), media: { create: input.mediaIds.map((mediaId, position) => ({ mediaId, position })) },
      variants: { create: input.variants.map((v) => ({ destinationId: v.destinationId, format: v.format,
        title: v.title, body: v.body ?? input.body, mediaIds: v.mediaIds ?? input.mediaIds, providerOptions: (v.providerOptions ?? {}) as Prisma.InputJsonObject })) },
    } });
  }
  private async invalidate(tx: Tx, id: string, status: "CANCELLED" | "SUPERSEDED", deliveryIds?: string[]) {
    const where = { postId: id, ...(deliveryIds ? { id: { in: deliveryIds } } : {}) };
    await tx.socialDelivery.updateMany({ where: { ...where, status: { in: [...pending] }, phase: { not: "PUBLISH" } },
      data: { status, leaseTokenHash: null, leaseUntil: null, cancellationRequested: true, completedAt: this.now() } });
    await tx.socialDeliveryAttempt.updateMany({ where: { status: "RUNNING", delivery: { ...where, status } },
      data: { status, endedAt: this.now() } });
    // A publish RPC already sent cannot be unsent. Keep its identity/progress and
    // fence later RPCs while exposing the unresolved outcome honestly.
    await tx.socialDelivery.updateMany({ where: { ...where, OR: [{ status: "LEASED", phase: "PUBLISH" }, { status: "UNCERTAIN" }] },
      data: { status: "UNCERTAIN", cancellationRequested: true, errorCode: status } });
  }
  async create(principal: CustomerPrincipal, input: SocialDraftInput) {
    await this.auth.assertSession(principal);
    const id = await this.db.$transaction(async (tx) => {
      await this.session(tx, principal); await this.verifiedDraft(tx, principal.userId, input);
      const post = await tx.socialPost.create({ data: { ownerId: principal.userId, title: input.title.trim() } });
      await this.addRevision(tx, post.id, 1, input); return post.id;
    });
    return this.get(principal, id);
  }
  async edit(principal: CustomerPrincipal, id: string, revisionId: string, input: SocialDraftInput) {
    await this.auth.assertSession(principal);
    await this.db.$transaction(async (tx) => {
      await this.session(tx, principal); const post = await this.owned(tx, principal, id);
      if (post.revisions[0]?.id !== revisionId) fail("STALE_REVISION", 409, "Review the current post before saving changes.");
      await this.verifiedDraft(tx, principal.userId, input);
      const claimed = await tx.socialPost.updateMany({ where: { id, ownerId: principal.userId, generation: post.generation },
        data: { currentRevision: { increment: 1 }, generation: { increment: 1 }, status: "DRAFT", title: input.title.trim() } });
      if (!claimed.count) fail("STALE_REVISION", 409, "The post changed while saving this revision.");
      await this.addRevision(tx, id, post.currentRevision + 1, input); await this.invalidate(tx, id, "SUPERSEDED");
    });
    return this.get(principal, id);
  }
  async list(principal: CustomerPrincipal) {
    await this.auth.assertSession(principal);
    const posts = await this.db.socialPost.findMany({ where: { ownerId: principal.userId }, orderBy: { updatedAt: "desc" }, take: 100, select: { id: true } });
    return { mode: this.config.mode, publishingEnabled: this.config.approvedProviders.some((key) => { const [platform, kind] = key.split(":"); return this.enabled(platform, kind); }),
      posts: await Promise.all(posts.map((p) => this.get(principal, p.id))) };
  }
  async get(principal: CustomerPrincipal, id: string) {
    await this.auth.assertSession(principal);
    const post = await this.db.socialPost.findFirst({ where: { id, ownerId: principal.userId }, include: {
      revisions: { orderBy: { number: "desc" }, take: 1, include: { media: { orderBy: { position: "asc" }, include: { media: true } },
        variants: { include: { destination: { include: { authorization: { select: { provider: true } } } } } } } },
      deliveries: { orderBy: { createdAt: "asc" } },
    } });
    if (!post) fail("NOT_FOUND", 404, "Social post not found.");
    const revision = post.revisions[0];
    return { id: post.id, title: post.title, category: post.category, status: post.status, currentRevision: post.currentRevision,
      generation: post.generation, mode: this.config.mode,
      publishingEnabled: Boolean(revision?.variants.length && revision.variants.every((v) => this.enabled(v.destination.authorization.provider, v.destination.kind))),
      revision: revision ? { id: revision.id, number: revision.number, title: revision.title, body: revision.body, reviewedAt: revision.reviewedAt,
        approvedDestinations: revision.approvedDestinations,
        media: revision.media.map(({ media: m }) => ({ id: m.id, mime: m.mime, type: m.type, bytes: m.bytes,
          width: m.width, height: m.height, durationMs: m.durationMs, expiresAt: m.expiresAt, status: m.status, filename: m.filename })),
        variants: revision.variants.map((v) => ({ id: v.id, destinationId: v.destinationId, format: v.format, title: v.title,
          body: v.body, mediaIds: v.mediaIds, providerOptions: v.providerOptions, provider: v.destination.authorization.provider, kind: v.destination.kind,
          name: v.destination.name, publishingEnabled: this.enabled(v.destination.authorization.provider, v.destination.kind) })),
      } : null,
      deliveries: post.deliveries.map((d) => ({ id: d.id, revisionId: d.revisionId, destinationId: d.destinationId,
        status: d.status, phase: d.phase, dueAt: d.dueAt, timeZone: d.timeZone, attempts: d.attempts,
        nextAttemptAt: d.nextAttemptAt, externalId: d.externalId, publishUrl: d.publishUrl, errorCode: d.errorCode,
        cancellationRequested: d.cancellationRequested, completedAt: d.completedAt })),
    };
  }
  async approve(principal: CustomerPrincipal, id: string, revisionId: string, destinationIds: string[]) {
    await this.auth.assertSession(principal); identifiers(destinationIds);
    if (!destinationIds.length) fail("INVALID_SELECTION", 400, "Review at least one explicit social destination.");
    await this.db.$transaction(async (tx) => {
      await this.session(tx, principal); const post = await this.owned(tx, principal, id), revision = post.revisions[0];
      if (revision?.id !== revisionId || post.status === "CANCELLED") fail("STALE_REVISION", 409, "Review the current editable post revision.");
      const variants = await tx.socialPostVariant.findMany({ where: { revisionId } });
      if (variants.length !== destinationIds.length || variants.some((v) => !destinationIds.includes(v.destinationId)))
        fail("INVALID_SELECTION", 400, "Review the exact destinations and variants shown in this post.");
      if (["APPROVED", "SCHEDULED", "COMPLETED"].includes(post.status)) {
        const approved = revision.approvedDestinations as string[] | null;
        if (!revision.reviewedAt || revision.reviewedById !== principal.userId || !approved || approved.length !== destinationIds.length ||
          approved.some((destinationId) => !destinationIds.includes(destinationId)))
          fail("REVIEW_REQUIRED", 409, "The approval does not match this reviewed revision.");
        return; // Exact approval retries preserve its timestamp and delivery state.
      }
      const bindings = await tx.socialRevisionMedia.findMany({ where: { revisionId }, include: { media: true } });
      verifyMedia(bindings.map((b) => b.media), principal.userId, bindings.map((b) => b.mediaId), this.now());
      for (const destinationId of destinationIds) await ownedDestination(tx, principal.userId, destinationId, this.config.mode, this.now());
      await tx.socialPostRevision.update({ where: { id: revisionId }, data: { reviewedAt: this.now(), reviewedById: principal.userId, approvedDestinations: [...destinationIds].sort() } });
      if (post.status !== "SCHEDULED") await tx.socialPost.update({ where: { id }, data: { status: "APPROVED" } });
    });
    return this.get(principal, id);
  }
  async enqueue(principal: CustomerPrincipal, id: string, input: SocialScheduleInput) {
    await this.auth.assertSession(principal); identifiers(input.destinationIds);
    if (!input.destinationIds.length || typeof input.enqueueId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(input.enqueueId))
      fail("INVALID_SELECTION", 400, "Supply approved destination IDs and a unique enqueue ID.");
    const timing = schedule(input.dueAt, input.timeZone, this.now());
    const requestDigest = digest(JSON.stringify([id, input.revisionId, [...input.destinationIds].sort(), timing.dueAt.toISOString(), timing.timeZone]));
    await this.db.$transaction(async (tx) => {
      await this.session(tx, principal); const post = await this.owned(tx, principal, id);
      const previous = await tx.socialEnqueue.findUnique({ where: { ownerId_key: { ownerId: principal.userId, key: input.enqueueId } } });
      if (previous) {
        if (previous.requestDigest !== requestDigest) fail("IDEMPOTENCY_CONFLICT", 409, "Use a new enqueue ID for a different reviewed request.");
        return;
      }
      const revision = post.revisions[0];
      if (revision?.id !== input.revisionId || !revision.reviewedAt || revision.reviewedById !== principal.userId || post.status !== "APPROVED")
        fail("REVIEW_REQUIRED", 409, "Approve the current content revision before scheduling it.");
      const approved = revision.approvedDestinations as string[] | null;
      if (!approved || approved.length !== input.destinationIds.length || approved.some((dest) => !input.destinationIds.includes(dest)))
        fail("REVIEW_REQUIRED", 409, "Approve the exact destination list before scheduling.");
      const bindings = await tx.socialRevisionMedia.findMany({ where: { revisionId: revision.id }, include: { media: true } });
      verifyMedia(bindings.map((b) => b.media), principal.userId, bindings.map((b) => b.mediaId), timing.dueAt);
      const variants = await tx.socialPostVariant.findMany({ where: { revisionId: revision.id } });
      const deliveries = [];
      for (const destinationId of input.destinationIds) {
        const destination = await ownedDestination(tx, principal.userId, destinationId, this.config.mode, this.now());
        const registration = this.registry.get(destination.authorization.provider, destination.kind);
        if (!this.enabled(destination.authorization.provider, destination.kind) || !registration)
          fail("PROVIDER_DISABLED", 503, "Publishing is unavailable until this provider is explicitly enabled and validated.");
        await ownedDestination(tx, principal.userId, destinationId, this.config.mode, this.now(), registration.requiredScopes);
        const variant = variants.find((v) => v.destinationId === destinationId);
        if (!variant || !registration.formats.includes(variant.format as never)) fail("UNSUPPORTED_CONTENT", 400, "Choose a supported destination variant.");
        registration.validateContent?.({ title: variant.title ?? revision.title, body: variant.body,
          format: variant.format as never, providerOptions: variant.providerOptions as Record<string, unknown> },
          (variant.mediaIds as string[]).map((mediaId) => bindings.find((b) => b.mediaId === mediaId)!.media));
        if (destination.authorization.expiresAt && destination.authorization.expiresAt <= timing.dueAt)
          fail("RECONNECT_REQUIRED", 409, "Renew provider access before its scheduled delivery time.");
        deliveries.push({ destinationId, variantId: variant.id, authorizationId: destination.authorizationId,
          authorizationGeneration: destination.authorization.generation, requiredScopes: [...registration.requiredScopes] });
      }
      if (await tx.socialDelivery.count({ where: { revisionId: revision.id } })) fail("ALREADY_SCHEDULED", 409, "Reschedule the existing deliveries instead of enqueueing the revision again.");
      const enqueue = await tx.socialEnqueue.create({ data: { ownerId: principal.userId, key: input.enqueueId, postId: id,
        revisionId: revision.id, requestDigest, ...timing, destinationIds: input.destinationIds } });
      await tx.socialDelivery.createMany({ data: deliveries.map((delivery) => ({ ...delivery, postId: id,
        revisionId: revision.id, enqueueId: enqueue.id, postGeneration: post.generation,
        connectionMode: this.config.mode.toUpperCase(), ...timing })) });
      await tx.socialPost.update({ where: { id }, data: { status: "SCHEDULED" } });
    });
    return this.get(principal, id);
  }
  private async chosen(tx: Tx, principal: CustomerPrincipal, id: string, deliveryIds: string[]) {
    identifiers(deliveryIds); if (!deliveryIds.length) fail("INVALID_SELECTION", 400, "Choose explicit delivery IDs.");
    const post = await this.owned(tx, principal, id);
    const deliveries = await tx.socialDelivery.findMany({ where: { id: { in: deliveryIds }, postId: id } });
    if (deliveries.length !== deliveryIds.length) fail("NOT_FOUND", 404, "Social delivery not found.");
    return { post, deliveries };
  }
  async cancel(principal: CustomerPrincipal, id: string, deliveryIds: string[]) {
    await this.auth.assertSession(principal);
    await this.db.$transaction(async (tx) => { await this.session(tx, principal); const { post } = await this.chosen(tx, principal, id, deliveryIds); await this.invalidate(tx, id, "CANCELLED", deliveryIds);
      await aggregateSocialPostStatus(tx, id, post.generation);
    }); return this.get(principal, id);
  }
  async reschedule(principal: CustomerPrincipal, id: string, deliveryIds: string[], dueAt: string, timeZone: string) {
    await this.auth.assertSession(principal); const timing = schedule(dueAt, timeZone, this.now());
    await this.db.$transaction(async (tx) => {
      await this.session(tx, principal); const { post, deliveries } = await this.chosen(tx, principal, id, deliveryIds);
      if (deliveries.some((d) => !["QUEUED", "RETRY_WAIT", "BLOCKED"].includes(d.status) || d.phase === "PUBLISH" ||
        d.publishStartedAt || d.postGeneration !== post.generation || d.cancellationRequested))
        fail("DELIVERY_IN_PROGRESS", 409, "Reconcile active or uncertain deliveries before rescheduling.");
      for (const d of deliveries) {
        const bindings = await tx.socialRevisionMedia.findMany({ where: { revisionId: d.revisionId }, include: { media: true } });
        verifyMedia(bindings.map((b) => b.media), principal.userId, bindings.map((b) => b.mediaId), timing.dueAt);
        const destination = await ownedDestination(tx, principal.userId, d.destinationId, this.config.mode, this.now(), d.requiredScopes as string[]);
        if (destination.authorizationId !== d.authorizationId || destination.authorization.generation !== d.authorizationGeneration)
          fail("STALE_CREDENTIALS", 409, "Approve a new revision after reconnecting this destination.");
        if (destination.authorization.expiresAt && destination.authorization.expiresAt <= timing.dueAt)
          fail("RECONNECT_REQUIRED", 409, "Renew provider access before its rescheduled delivery time.");
      }
      const changed = await tx.socialDelivery.updateMany({ where: { id: { in: deliveryIds }, status: { in: ["QUEUED", "RETRY_WAIT", "BLOCKED"] } },
        data: { ...timing, nextAttemptAt: null, status: "QUEUED", errorCode: null } });
      if (changed.count !== deliveries.length) fail("DELIVERY_IN_PROGRESS", 409, "The delivery changed while rescheduling.");
    }); return this.get(principal, id);
  }
  async retry(principal: CustomerPrincipal, id: string, deliveryIds: string[]) {
    await this.auth.assertSession(principal);
    await this.db.$transaction(async (tx) => {
      await this.session(tx, principal); const { post, deliveries } = await this.chosen(tx, principal, id, deliveryIds);
      if (deliveries.some((d) => !["FAILED", "BLOCKED", "RETRY_WAIT"].includes(d.status) || d.phase === "PUBLISH" || d.publishStartedAt ||
        d.cancellationRequested || d.postGeneration !== post.generation || d.attempts >= (this.config.maxAttempts ?? 5)))
        fail("RECONCILIATION_REQUIRED", 409, "Retry only unresolved safe failures; reconcile uncertain publish outcomes first.");
      for (const d of deliveries) {
        const destination = await ownedDestination(tx, principal.userId, d.destinationId, this.config.mode, this.now(), d.requiredScopes as string[]);
        if (destination.authorizationId !== d.authorizationId || destination.authorization.generation !== d.authorizationGeneration)
          fail("STALE_CREDENTIALS", 409, "Approve a new revision after reconnecting this destination.");
      }
      await tx.socialDelivery.updateMany({ where: { id: { in: deliveryIds }, status: { in: ["FAILED", "BLOCKED", "RETRY_WAIT"] } },
        data: { status: "QUEUED", nextAttemptAt: null, errorCode: null } });
    }); return this.get(principal, id);
  }
}
