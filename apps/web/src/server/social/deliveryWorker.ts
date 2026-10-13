import { randomBytes } from "node:crypto";
import type { Prisma, PrismaClient, SocialDeliveryPhase } from "../../generated/prisma/client";
import { digest } from "../auth/customerAuth";
import { credentialContext } from "../connections/customerConnections";
import { CredentialVault } from "../security/credentialVault";
import { fail, SecurityError } from "../security/errors";
import { SocialProviderFailure, SocialProviderRegistry, type SocialCredentialRenewal, type SocialMediaResolver, type SocialProgress,
  type SocialProviderContext, type SocialPublished, type SocialWorkerConfig } from "./types";
import { aggregateSocialPostStatus } from "./aggregate";
import { ownedDestination, verifyFormat, verifyMedia } from "./validation";
import { publicMedia } from "./mediaStore";

const work = ["QUEUED", "RETRY_WAIT"] as const;
const safeCodes = new Set(["PROVIDER_DISABLED", "RECONNECT_REQUIRED", "MISSING_PERMISSION", "MEDIA_UNAVAILABLE", "UNSUPPORTED_CONTENT", "CONNECTION_MODE_MISMATCH", "STALE_CREDENTIALS", "STALE_REVISION", "REVIEW_REQUIRED", "INVALID_PROVIDER_OPTIONS", "LEASE_LOST", "NOT_FOUND", "CREDENTIAL_UNAVAILABLE"]);
const publicHosts: Record<string, readonly string[]> = {
  GOOGLE: ["youtube.com", "www.youtube.com", "youtu.be"], META: ["facebook.com", "www.facebook.com", "instagram.com", "www.instagram.com"],
  TIKTOK: ["tiktok.com", "www.tiktok.com"], LINKEDIN: ["linkedin.com", "www.linkedin.com"], X: ["x.com", "www.x.com", "twitter.com", "www.twitter.com"],
};
type Lease = { id: string; token: string; hash: string; attempt: number };

/** Scheduled jobs authorize from durable ownership/grants, never a browser session. */
export class SocialDeliveryWorker {
  private readonly config: Readonly<SocialWorkerConfig>;
  private readonly leaseMs: number;
  private readonly maximum: number;
  constructor(private readonly db: PrismaClient, private readonly vault: CredentialVault,
    private readonly registry: SocialProviderRegistry, config: SocialWorkerConfig,
    private readonly mediaResolver?: SocialMediaResolver, private readonly now = () => new Date(),
    private readonly renewCredentials?: SocialCredentialRenewal) {
    if (!["mock", "live"].includes(config.mode)) fail("PROVIDER_DISABLED", 503, "Configure an explicit social provider mode.");
    this.config = Object.freeze({ ...config, approvedProviders: Object.freeze([...config.approvedProviders]) });
    this.leaseMs = Math.min(900_000, Math.max(1000, config.leaseMs ?? 120_000));
    this.maximum = Math.min(10, Math.max(1, config.maxAttempts ?? 5));
  }
  private async recover(tx: Prisma.TransactionClient) {
    const expired = await tx.socialDelivery.findMany({ where: {
      connectionMode: this.config.mode.toUpperCase(), leaseUntil: { lte: this.now() },
      OR: [{ status: "LEASED" }, { status: "UNCERTAIN", leaseTokenHash: { not: null } }],
    } });
    for (const delivery of expired) {
      const uncertain = delivery.status === "UNCERTAIN" || delivery.phase === "PUBLISH" || Boolean(delivery.publishStartedAt);
      const changed = await tx.socialDelivery.updateMany({ where: { id: delivery.id, connectionMode: this.config.mode.toUpperCase(), status: delivery.status,
        leaseUntil: { lte: this.now() }, leaseTokenHash: delivery.leaseTokenHash },
        data: { status: uncertain ? "UNCERTAIN" : delivery.attempts >= this.maximum ? "FAILED" : "RETRY_WAIT",
          errorCode: uncertain ? "PUBLISH_OUTCOME_UNKNOWN" : "WORKER_INTERRUPTED", leaseUntil: null, leaseTokenHash: null,
          nextAttemptAt: uncertain ? null : this.now() } });
      if (changed.count) await tx.socialDeliveryAttempt.updateMany({ where: { deliveryId: delivery.id, status: "RUNNING" },
        data: { status: uncertain ? "UNCERTAIN" : "INTERRUPTED", errorCode: uncertain ? "PUBLISH_OUTCOME_UNKNOWN" : "WORKER_INTERRUPTED", endedAt: this.now() } });
    }
  }
  private async claim(id?: string, reconciliation = false): Promise<Lease | null> {
    const token = randomBytes(32).toString("base64url"), hash = digest(token);
    return this.db.$transaction(async (tx) => {
      await this.recover(tx);
      const delivery = await tx.socialDelivery.findFirst({ where: {
        ...(id ? { id } : {}), connectionMode: this.config.mode.toUpperCase(),
        status: reconciliation ? "UNCERTAIN" : { in: [...work] },
        ...(reconciliation ? { leaseTokenHash: null, ...(!id ? { attempts: { lt: this.maximum + 3 } } : {}), OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: this.now() } }] } : { cancellationRequested: false, dueAt: { lte: this.now() }, attempts: { lt: this.maximum },
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: this.now() } }] }),
      }, orderBy: { dueAt: "asc" } });
      if (!delivery) return null;
      const attempt = delivery.attempts + 1;
      const changed = await tx.socialDelivery.updateMany({ where: { id: delivery.id, status: delivery.status,
        leaseTokenHash: delivery.leaseTokenHash, attempts: delivery.attempts, dueAt: delivery.dueAt,
        nextAttemptAt: delivery.nextAttemptAt, cancellationRequested: delivery.cancellationRequested }, data: {
          status: "LEASED", leaseTokenHash: hash, leaseUntil: new Date(this.now().getTime() + this.leaseMs), attempts: attempt,
        } });
      if (!changed.count) return null;
      await tx.socialDeliveryAttempt.create({ data: { deliveryId: delivery.id, number: attempt, leaseHash: hash, startedAt: this.now() } });
      return { id: delivery.id, token, hash, attempt };
    });
  }
  private async verified(tx: Prisma.TransactionClient, lease: Lease, reconciliation = false, credentialVersion?: number, allowExpiredForRenewal = false) {
    const delivery = await tx.socialDelivery.findUnique({ where: { id: lease.id }, include: {
      post: true, revision: { include: { media: { include: { media: true } } } }, variant: true,
      destination: { include: { authorization: true } }, progress: true,
    } });
    if (!delivery || delivery.leaseTokenHash !== lease.hash || !["LEASED", "UNCERTAIN"].includes(delivery.status) ||
      !delivery.leaseUntil || delivery.leaseUntil <= this.now()) fail("LEASE_LOST", 409, "The delivery lease is no longer current.");
    if (!reconciliation && (delivery.status !== "LEASED" || delivery.cancellationRequested || delivery.post.generation !== delivery.postGeneration ||
      delivery.post.currentRevision !== delivery.revision.number || !delivery.revision.reviewedAt ||
      delivery.revision.reviewedById !== delivery.post.ownerId || !(delivery.revision.approvedDestinations as string[] | null)?.includes(delivery.destinationId)))
      fail("STALE_REVISION", 409, "The reviewed delivery was cancelled or superseded.");
    const registration = this.registry.get(delivery.destination.authorization.provider, delivery.destination.kind);
    if (!this.config.writesEnabled || !this.config.approvedProviders.includes(`${delivery.destination.authorization.provider}:${delivery.destination.kind}`) ||
      !registration?.modes.includes(this.config.mode)) fail("PROVIDER_DISABLED", 503, "This social provider is not enabled for publishing.");
    const destination = await ownedDestination(tx, delivery.post.ownerId, delivery.destinationId, this.config.mode, this.now(),
      [...new Set([...(delivery.requiredScopes as string[]), ...registration.requiredScopes])], allowExpiredForRenewal);
    const grant = destination.authorization;
    if (grant.id !== delivery.authorizationId || grant.generation !== delivery.authorizationGeneration ||
      delivery.connectionMode !== this.config.mode.toUpperCase() || (credentialVersion !== undefined && grant.credentialVersion !== credentialVersion))
      fail("STALE_CREDENTIALS", 409, "The authorization changed during this delivery.");
    const ids = delivery.variant.mediaIds as string[];
    const media = ids.map((id) => delivery.revision.media.find((binding) => binding.mediaId === id)?.media).filter((m) => m !== undefined);
    const minimumValidUntil = new Date(this.now().getTime() + Math.max(0, registration.mediaFetchWindowMs ?? 60_000));
    if (!reconciliation) {
      verifyMedia(media, delivery.post.ownerId, ids, minimumValidUntil);
      verifyFormat(delivery.variant.format as never, destination.kind, media);
      if (!registration.formats.includes(delivery.variant.format as never)) fail("UNSUPPORTED_CONTENT", 400, "This content format is not supported by the destination.");
      registration.validateContent?.({ title: delivery.variant.title ?? delivery.revision.title, body: delivery.variant.body,
        format: delivery.variant.format as never, providerOptions: delivery.variant.providerOptions as Record<string, unknown> }, media);
    }
    return { delivery, destination, grant, registration, media, minimumValidUntil };
  }
  private async ensureCredentials(lease: Lease, reconciliation: boolean) {
    const snapshot = await this.db.$transaction((tx) => this.verified(tx, lease, reconciliation, undefined, true));
    const old = snapshot.grant;
    if (!old.expiresAt || old.expiresAt.getTime() > this.now().getTime() + 60_000) return;
    if (!snapshot.registration.renewableCredentials || !this.renewCredentials || !old.refreshCiphertext)
      fail("RECONNECT_REQUIRED", 409, "Renew publishing access before this delivery can continue.");
    const verifyCurrent = async () => { await this.db.$transaction((tx) => this.verified(tx, lease, reconciliation, old.credentialVersion, true)); };
    const adoptCurrent = async () => {
      const current = await this.db.$transaction((tx) => this.verified(tx, lease, reconciliation, undefined, true));
      return current.grant.credentialVersion !== old.credentialVersion && current.grant.expiresAt !== null &&
        current.grant.expiresAt.getTime() > this.now().getTime() + 60_000;
    };
    let renewed;
    try {
      renewed = await this.renewCredentials({ authorizationId: old.id, ownerId: old.userId, authorizationGeneration: old.generation,
        credentialVersion: old.credentialVersion, mode: this.config.mode, provider: old.provider, providerUserId: old.providerUserId,
        refreshToken: this.vault.decrypt(old.refreshCiphertext, credentialContext(old.userId, old.id, "refresh")),
        scopes: old.scopes as string[], verifyCurrent });
    } catch (error) {
      // Concurrent renewals may adopt a winner only after the complete lease,
      // owner, scope, mode and authorization-generation fences still pass.
      if (await adoptCurrent()) return;
      if (error instanceof SecurityError && error.status === 429)
        throw new SocialProviderFailure("RATE_LIMIT", true);
      // Google offline credentials are reusable. This does not authorize retry
      // of an ambiguous rotating-token exchange for another platform.
      if (old.provider === "GOOGLE" && error instanceof SecurityError && error.status >= 500 &&
        "retryable" in error && error.retryable === true && !("outcomeUnknown" in error && error.outcomeUnknown === true))
        throw new SocialProviderFailure("TRANSIENT", true);
      throw error;
    }
    const scopes = renewed.scopes;
    if (renewed.providerUserId !== old.providerUserId || typeof renewed.accessToken !== "string" || !renewed.accessToken || renewed.accessToken.length > 32768 ||
      !renewed.expiresAt || !Number.isFinite(renewed.expiresAt.getTime()) || renewed.expiresAt <= this.now() || !Array.isArray(scopes) ||
      !snapshot.registration.requiredScopes.every((scope) => scopes.includes(scope)) ||
      (renewed.refreshToken !== undefined && (!renewed.refreshToken || renewed.refreshToken.length > 32768)))
      fail("RECONNECT_REQUIRED", 409, "The provider could not verify renewed publishing access.");
    try { await this.db.$transaction(async (tx) => {
      await this.verified(tx, lease, reconciliation, old.credentialVersion, true);
      const changed = await tx.providerAuthorization.updateMany({ where: { id: old.id, userId: old.userId,
        credentialVersion: old.credentialVersion, generation: old.generation, capability: "SOCIAL", connectionMode: old.connectionMode, status: "CONNECTED" },
        data: { accessCiphertext: this.vault.encrypt(renewed.accessToken, credentialContext(old.userId, old.id, "access")),
          ...(renewed.refreshToken ? { refreshCiphertext: this.vault.encrypt(renewed.refreshToken, credentialContext(old.userId, old.id, "refresh")) } : {}),
          expiresAt: renewed.expiresAt, scopes, credentialVersion: { increment: 1 } } });
      if (!changed.count) fail("STALE_CREDENTIALS", 409, "The publishing authorization changed during renewal.");
      await tx.connectionAuditEvent.create({ data: { authorizationId: old.id, action: "SOCIAL_CREDENTIALS_RENEWED" } });
    }); } catch (error) { if (await adoptCurrent()) return; throw error; }
  }
  private progressContext(id: string) { return `social-progress-v1:${id}`; }
  private decode(id: string, encryptedState?: string) {
    if (!encryptedState) return {};
    try {
      const value: unknown = JSON.parse(this.vault.decrypt(encryptedState, this.progressContext(id)));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value as SocialProgress;
    } catch { fail("CREDENTIAL_UNAVAILABLE", 503, "Saved upload progress is unavailable. Check the server keyring."); }
  }
  private async checkpoint(lease: Lease, value: SocialProgress, reconciliation: boolean) {
    const encoded = JSON.stringify(value);
    if (!value || typeof value !== "object" || Array.isArray(value) || encoded.length > 65_536)
      fail("INVALID_PROVIDER_PROGRESS", 502, "The provider returned unsupported upload progress.");
    const encryptedState = this.vault.encrypt(encoded, this.progressContext(lease.id));
    await this.db.$transaction(async (tx) => {
      await this.verified(tx, lease, reconciliation);
      await tx.socialDeliveryProgress.upsert({ where: { deliveryId: lease.id }, create: { deliveryId: lease.id, encryptedState },
        update: { encryptedState, version: { increment: 1 } } });
    });
  }
  private published(platform: string, value: SocialPublished) {
    if (!value || typeof value.externalId !== "string" || !/^[A-Za-z0-9_:~.-]{1,256}$/.test(value.externalId))
      fail("INVALID_PROVIDER_RESPONSE", 502, "The provider did not return a valid publication identity.");
    if (value.publishUrl !== undefined) {
      let url: URL; try { url = new URL(value.publishUrl); } catch { fail("INVALID_PROVIDER_RESPONSE", 502, "The provider did not return a public publication link."); }
      if (url.protocol !== "https:" || url.username || url.password || !publicHosts[platform]?.includes(url.hostname) || url.hash ||
        [...url.searchParams].some(([key, v]) => !["v", "id", "story_fbid"].includes(key) || !/^[A-Za-z0-9_-]{1,256}$/.test(v)))
        fail("INVALID_PROVIDER_RESPONSE", 502, "The provider did not return a public publication link.");
    }
    return { externalId: value.externalId, publishUrl: value.publishUrl };
  }
  private async finish(lease: Lease, status: "SUCCEEDED" | "FAILED" | "QUEUED" | "UNCERTAIN", result?: SocialPublished, reconciliation = false) {
    return this.db.$transaction(async (tx) => {
      const delivery = await tx.socialDelivery.findUnique({ where: { id: lease.id }, include: { post: true, destination: { include: { authorization: true } } } });
      if (!delivery || delivery.leaseTokenHash !== lease.hash) fail("LEASE_LOST", 409, "The delivery lease is no longer current.");
      const obsolete = delivery.cancellationRequested || delivery.post.generation !== delivery.postGeneration;
      const outcome = status === "QUEUED" && obsolete ? (delivery.cancellationRequested ? "CANCELLED" : "SUPERSEDED") : status;
      const publication = result ? this.published(delivery.destination.authorization.provider, result) : undefined;
      await tx.socialDelivery.update({ where: { id: lease.id }, data: {
        status: outcome, phase: status === "SUCCEEDED" || status === "FAILED" ? "COMPLETE" : status === "QUEUED" ? "PREPARE" : "PUBLISH",
        ...(publication ? publication : {}), leaseTokenHash: null, leaseUntil: null,
        ...(status === "QUEUED" ? { publishStartedAt: null, nextAttemptAt: this.now() } : {}),
        nextAttemptAt: status === "UNCERTAIN" ? new Date(this.now().getTime() + Math.min(3600_000, 1000 * 2 ** Math.min(lease.attempt, 12))) : null,
        errorCode: status === "FAILED" ? "PROVIDER_PROCESSING_FAILED" : status === "UNCERTAIN" ? "PUBLISH_OUTCOME_UNKNOWN" : obsolete && status === "SUCCEEDED" ? "PUBLISHED_AFTER_CANCELLATION" : null,
        completedAt: status === "SUCCEEDED" || status === "FAILED" || outcome === "CANCELLED" || outcome === "SUPERSEDED" ? this.now() : null,
      } });
      await tx.socialDeliveryAttempt.updateMany({ where: { deliveryId: lease.id, number: lease.attempt, leaseHash: lease.hash, status: "RUNNING" },
        data: { status: outcome, endedAt: this.now() } });
      await aggregateSocialPostStatus(tx, delivery.postId, delivery.postGeneration);
      return { deliveryId: lease.id, status: outcome, ...(publication ?? {}), reconciled: reconciliation };
    });
  }
  private async failed(lease: Lease, error: unknown, reconciliation = false, definitivePublishRejection = false) {
    return this.db.$transaction(async (tx) => {
      const delivery = await tx.socialDelivery.findUnique({ where: { id: lease.id } });
      if (!delivery || delivery.leaseTokenHash !== lease.hash) return { deliveryId: lease.id, status: "LEASE_LOST" };
      const uncertain = Boolean(delivery.publishStartedAt) && (reconciliation || !definitivePublishRejection);
      const guard = error instanceof SecurityError && safeCodes.has(error.code);
      const blocked = guard || (error instanceof SocialProviderFailure && ["EXPIRED", "TERMINAL"].includes(error.kind));
      const retryable = !uncertain && !blocked && error instanceof SocialProviderFailure && error.definitive &&
        ["RATE_LIMIT", "TRANSIENT"].includes(error.kind) && lease.attempt < this.maximum;
      const code = uncertain ? "PUBLISH_OUTCOME_UNKNOWN" : guard ? error.code : error instanceof SocialProviderFailure ?
        error.kind === "RATE_LIMIT" ? "PROVIDER_RATE_LIMITED" : error.kind === "EXPIRED" ? "RECONNECT_REQUIRED" : "PROVIDER_FAILED" : "PROVIDER_FAILED";
      const maxBackoff = Math.min(86_400_000, Math.max(1000, this.config.maxBackoffMs ?? 3600_000));
      const backoff = Math.min(maxBackoff, Math.max(1000, error instanceof SocialProviderFailure && Number.isFinite(error.retryAfterMs) ? error.retryAfterMs! : 1000 * 2 ** Math.min(lease.attempt, 16)));
      const status = uncertain ? "UNCERTAIN" : blocked ? "BLOCKED" : retryable ? "RETRY_WAIT" : "FAILED";
      await tx.socialDelivery.update({ where: { id: lease.id }, data: { status, errorCode: code, leaseUntil: null, leaseTokenHash: null,
        nextAttemptAt: retryable || (uncertain && reconciliation) ? new Date(this.now().getTime() + backoff) : null,
        ...(uncertain ? {} : { publishStartedAt: null, phase: "PREPARE" }), completedAt: status === "FAILED" ? this.now() : null } });
      await tx.socialDeliveryAttempt.updateMany({ where: { deliveryId: lease.id, number: lease.attempt, leaseHash: lease.hash, status: "RUNNING" },
        data: { status, errorCode: code, endedAt: this.now() } });
      return { deliveryId: lease.id, status, errorCode: code };
    });
  }
  private async execute(lease: Lease, reconciliation: boolean) {
    let stage: "VALIDATE" | "PREPARE" | "PUBLISH" | "STATUS" = reconciliation ? "STATUS" : "VALIDATE";
    let publishCalls = 0;
    let definitivePublishFailure: SocialProviderFailure | undefined;
    try {
      await this.ensureCredentials(lease, reconciliation);
      const initial = await this.db.$transaction((tx) => this.verified(tx, lease, reconciliation));
      const provider = this.registry.create(initial.destination.authorization.provider, initial.destination.kind);
      const context: SocialProviderContext = {
        deliveryId: lease.id, revisionId: initial.delivery.revisionId,
        content: Object.freeze({ title: initial.delivery.variant.title ?? initial.delivery.revision.title, body: initial.delivery.variant.body,
          format: initial.delivery.variant.format as never, providerOptions: Object.freeze(initial.delivery.variant.providerOptions as Record<string, unknown>) }),
        checkpoint: (progress) => this.checkpoint(lease, progress, reconciliation),
        rpc: async (phase, invoke) => {
          if ((phase === "PUBLISH" && stage !== "PUBLISH") || (phase === "PUBLISH" && publishCalls++ > 0))
            fail("INVALID_PROVIDER_PROTOCOL", 502, "The provider attempted an unsupported publication transition.");
          await this.ensureCredentials(lease, reconciliation);
          const snapshot = await this.db.$transaction((tx) => this.verified(tx, lease, reconciliation));
          const urls = snapshot.media.length && !reconciliation ? await this.mediaResolver?.({ ownerId: snapshot.delivery.post.ownerId,
            deliveryId: lease.id, revisionId: snapshot.delivery.revisionId, media: snapshot.media, minimumValidUntil: snapshot.minimumValidUntil }) : [];
          if (snapshot.media.length && !reconciliation && (!urls || urls.length !== snapshot.media.length || snapshot.media.some((m) => !urls.some((u) => u.id === m.id))))
            fail("MEDIA_UNAVAILABLE", 503, "Verified media is unavailable to the provider.");
          await this.db.$transaction(async (tx) => {
            const current = await this.verified(tx, lease, reconciliation, snapshot.grant.credentialVersion);
            await tx.socialDelivery.update({ where: { id: lease.id }, data: {
              phase: current.delivery.publishStartedAt || reconciliation ? "PUBLISH" : phase,
              ...(phase === "PUBLISH" ? { publishStartedAt: current.delivery.publishStartedAt ?? this.now() } : {}),
              leaseUntil: new Date(this.now().getTime() + this.leaseMs),
            } });
          });
          try { return await invoke({ mode: this.config.mode, authorizationId: snapshot.grant.id, providerUserId: snapshot.grant.providerUserId,
            authorizationGeneration: snapshot.grant.generation, accessToken: this.vault.decrypt(snapshot.grant.accessCiphertext!,
            credentialContext(snapshot.grant.userId, snapshot.grant.id, "access")),
            refreshToken: snapshot.grant.refreshCiphertext ? this.vault.decrypt(snapshot.grant.refreshCiphertext,
              credentialContext(snapshot.grant.userId, snapshot.grant.id, "refresh")) : undefined,
            verifyCurrent: async () => { await this.db.$transaction((tx) => this.verified(tx, lease, reconciliation, snapshot.grant.credentialVersion)); },
            destination: { externalId: snapshot.destination.externalId, kind: snapshot.destination.kind, metadata: snapshot.destination.metadata },
            media: snapshot.media.map((m) => ({ id: m.id, url: urls?.find((u) => u.id === m.id)?.url ?? "", mime: m.mime,
              bytes: m.bytes, width: m.width, height: m.height, durationMs: m.durationMs, metadata: publicMedia(m).metadata })),
          }); } catch (error) {
            // Only a definitive failure from the submission RPC itself proves
            // it was rejected. A later poll/checkpoint failure cannot erase an
            // accepted submission and make another publish eligible.
            if (phase === "PUBLISH" && error instanceof SocialProviderFailure && error.definitive)
              definitivePublishFailure = error;
            throw error;
          }
        },
      };
      let progress = this.decode(lease.id, initial.delivery.progress?.encryptedState);
      if (reconciliation) {
        const status = await provider.status(context, progress);
        if (status.status === "PUBLISHED") return await this.finish(lease, "SUCCEEDED", status.result, true);
        if (status.status === "FAILED") return await this.finish(lease, "FAILED", status.result, true);
        return await this.finish(lease, status.status === "NOT_PUBLISHED" ? "QUEUED" : "UNCERTAIN", undefined, true);
      }
      await provider.validate(context);
      stage = "PREPARE"; progress = await provider.prepare(context, progress); await this.checkpoint(lease, progress, false);
      // Mark the ambiguous publication boundary before the adapter can submit.
      await this.db.$transaction(async (tx) => { await this.verified(tx, lease); await tx.socialDelivery.update({ where: { id: lease.id },
        data: { phase: "PUBLISH", publishStartedAt: this.now() } }); });
      stage = "PUBLISH";
      const result = await provider.publish(context, progress);
      return await this.finish(lease, "SUCCEEDED", result);
    } catch (error) { return this.failed(lease, error, reconciliation, definitivePublishFailure !== undefined && error === definitivePublishFailure); }
  }
  async runOnce() { if (!this.config.writesEnabled) return null; const lease = await this.claim(); return lease ? this.execute(lease, false) : null; }
  async reconcileNext() { if (!this.config.writesEnabled) return null; const lease = await this.claim(undefined, true); return lease ? this.execute(lease, true) : null; }
  async reconcileOnce(deliveryId: string) { if (!this.config.writesEnabled) return null; const lease = await this.claim(deliveryId, true); return lease ? this.execute(lease, true) : null; }
}
