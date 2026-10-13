import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Platform, Prisma, PrismaClient, ProviderAuthorization } from "../../generated/prisma/client";
import { digest } from "../auth/customerAuth";
import { credentialContext } from "./customerConnections";
import { CredentialVault } from "../security/credentialVault";
import { fail } from "../security/errors";
import { cancelSocialDeliveries } from "../social/connectionLifecycle";
import { SocialProviderFailure } from "../social/types";

export type RotatingSocialProvider = Extract<Platform, "TIKTOK" | "X" | "LINKEDIN">;
export type VerifiedRotatedSocialGrant = {
  providerUserId: string; accessToken: string; refreshToken: string; scopes: string[]; expiresAt: Date;
  /** Actual provider expiry; null explicitly represents an unknown/not-supplied lifetime. */
  refreshExpiresAt: Date | null;
};
export type SocialRenewalSnapshot = Readonly<{
  ownerId: string; authorizationId: string; provider: RotatingSocialProvider; providerUserId: string;
  connectionMode: "MOCK" | "LIVE"; generation: number; credentialVersion: number;
  accessToken: string; refreshToken: string; scopes: readonly string[];
  expiresAt: Date | null; refreshExpiresAt: Date | null;
}>;
export type SocialRotatingRenewalRequest = {
  ownerId: string; authorizationId: string; provider: RotatingSocialProvider;
  generation: number; credentialVersion: number; requiredScopes: readonly string[];
  /** Session/job checks run outside the coordinator's transactions, before every HTTP boundary. */
  verifyCaller(): Promise<void>;
  /** First HTTP must be the token exchange; all subsequent HTTP must use the same guard. */
  exchange(snapshot: SocialRenewalSnapshot, beforeRequest: () => Promise<void>): Promise<VerifiedRotatedSocialGrant>;
};
/** Only a structured rejection of the first token request can prove the old rotating token was not consumed. */
export class SocialRenewalExchangeError extends Error {
  constructor(readonly kind: "RATE_LIMIT" | "TRANSIENT", readonly exchangeRejected: boolean,
    readonly retryAfterMs?: number) { super("The publishing credential exchange could not be completed."); }
}
type Claim = { kind: "owned"; hash: string; snapshot: SocialRenewalSnapshot } |
  { kind: "adopted"; grant: VerifiedRotatedSocialGrant } | { kind: "busy" } | { kind: "reconnect" };

/** Durable rotation fence shared by scheduled workers and session-owned connection checks. */
export class SocialCredentialRenewalState {
  private readonly mode: "MOCK" | "LIVE";
  private readonly leaseMs: number;
  private readonly now: () => Date;
  constructor(private readonly db: PrismaClient, private readonly vault: CredentialVault,
    config: { mode: "mock" | "live"; leaseMs?: number; now?: () => Date }) {
    if (!["mock", "live"].includes(config.mode) || (config.leaseMs !== undefined && !Number.isSafeInteger(config.leaseMs)))
      fail("INVALID_CONFIG", 503, "Configure an explicit credential renewal mode and lease.");
    this.mode = config.mode === "mock" ? "MOCK" : "LIVE";
    this.leaseMs = Math.min(900_000, Math.max(1000, config.leaseMs ?? 120_000));
    this.now = config.now ?? (() => new Date());
  }
  private async transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.$transaction(async (tx) => {
          // Reserve the SQLite writer before reading. Separate worker connections
          // cannot both upgrade a held read snapshot into a refresh claim.
          await tx.$executeRaw`UPDATE "SocialCredentialRenewalLease" SET "requestCount" = "requestCount" WHERE 0`;
          return work(tx);
        }, { timeout: 15_000, maxWait: 15_000 });
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
        const contention = ["P2034", "SQLITE_BUSY", "SQLITE_BUSY_SNAPSHOT"].includes(code) ||
          (code === "P2010" && error instanceof Error && /\bSQLITE_BUSY\b/.test(error.message));
        if (!contention || attempt >= 2) throw error;
        // Only an aborted database transaction is repeated; HTTP is outside it.
        await delay(20 * (attempt + 1));
      }
    }
  }
  private fingerprint(row: ProviderAuthorization, refreshToken: string) {
    return digest(JSON.stringify(["social-refresh-v1", row.userId, row.id, row.connectionMode, row.generation, refreshToken]));
  }
  private snapshot(row: ProviderAuthorization): SocialRenewalSnapshot {
    if (!row.accessCiphertext || !row.refreshCiphertext) fail("RECONNECT_REQUIRED", 409, "Reconnect before renewing publishing access.");
    return Object.freeze({ ownerId: row.userId, authorizationId: row.id, provider: row.provider as RotatingSocialProvider,
      providerUserId: row.providerUserId, connectionMode: row.connectionMode as "MOCK" | "LIVE", generation: row.generation,
      credentialVersion: row.credentialVersion, accessToken: this.vault.decrypt(row.accessCiphertext, credentialContext(row.userId, row.id, "access")),
      refreshToken: this.vault.decrypt(row.refreshCiphertext, credentialContext(row.userId, row.id, "refresh")),
      scopes: Object.freeze([...(row.scopes as string[])]), expiresAt: row.expiresAt, refreshExpiresAt: row.refreshExpiresAt });
  }
  private grant(tx: Prisma.TransactionClient, request: SocialRotatingRenewalRequest) {
    return tx.providerAuthorization.findFirst({ where: { id: request.authorizationId, userId: request.ownerId,
      provider: request.provider, capability: "SOCIAL", connectionMode: this.mode, status: "CONNECTED", generation: request.generation } });
  }
  private scopeGuard(row: ProviderAuthorization, request: SocialRotatingRenewalRequest) {
    if (!Array.isArray(row.scopes) || (row.scopes as unknown[]).some(s => typeof s !== "string") ||
      request.requiredScopes.some(s => !(row.scopes as string[]).includes(s)))
      fail("MISSING_PERMISSION", 403, "Restore the permissions required for publishing.");
  }
  private async reconnect(tx: Prisma.TransactionClient, row: ProviderAuthorization) {
    const changed = await tx.providerAuthorization.updateMany({ where: { id: row.id, userId: row.userId, provider: row.provider,
      capability: "SOCIAL", connectionMode: row.connectionMode, generation: row.generation, credentialVersion: row.credentialVersion, status: "CONNECTED" },
      data: { status: "RECONNECT_REQUIRED", accessCiphertext: null, refreshCiphertext: null, generation: { increment: 1 },
        credentialVersion: { increment: 1 }, disconnectedAt: this.now() } });
    if (!changed.count) return;
    await tx.oAuthAttempt.updateMany({ where: { userId: row.userId, provider: row.provider, capability: "SOCIAL", consumedAt: null },
      data: { consumedAt: this.now(), verifierCiphertext: null, exchangeClaimHash: null } });
    await tx.connectionDestination.updateMany({ where: { authorizationId: row.id }, data: { selected: false } });
    await cancelSocialDeliveries(tx, [row.id], "RECONNECT_REQUIRED", this.now());
    await tx.connectionOperation.updateMany({ where: { destination: { authorizationId: row.id }, status: { in: ["PENDING", "RUNNING"] } },
      data: { status: "CANCELLED", completedAt: this.now() } });
    await tx.connectionAuditEvent.create({ data: { authorizationId: row.id, action: "SOCIAL_REFRESH_RECONNECT_REQUIRED" } });
  }
  private async claim(request: SocialRotatingRenewalRequest): Promise<Claim> {
    await request.verifyCaller();
    const hash = digest(randomBytes(32).toString("base64url"));
    return this.transaction(async tx => {
      const row = await this.grant(tx, request);
      if (!row) fail("STALE_CREDENTIALS", 409, "The publishing authorization changed before renewal.");
      this.scopeGuard(row, request);
      const snapshot = this.snapshot(row), fingerprint = this.fingerprint(row, snapshot.refreshToken);
      const previous = await tx.socialCredentialRenewalLease.findUnique({ where: { authorizationId: row.id } });
      const sameConsentAndToken = previous && previous.ownerId === row.userId && previous.provider === row.provider &&
        previous.connectionMode === row.connectionMode && previous.authorizationGeneration === row.generation && previous.refreshDigest === fingerprint;
      if (sameConsentAndToken && previous.leaseUntil > this.now()) return { kind: "busy" };
      if (sameConsentAndToken && previous.startedAt) { await this.reconnect(tx, row); return { kind: "reconnect" }; }
      if (row.refreshExpiresAt && row.refreshExpiresAt <= this.now()) { await this.reconnect(tx, row); return { kind: "reconnect" }; }
      if (row.credentialVersion > request.credentialVersion && row.expiresAt && row.expiresAt.getTime() > this.now().getTime() + 60_000)
        return { kind: "adopted", grant: { providerUserId: row.providerUserId, accessToken: snapshot.accessToken, refreshToken: snapshot.refreshToken,
          scopes: [...snapshot.scopes], expiresAt: row.expiresAt, refreshExpiresAt: row.refreshExpiresAt } };
      if (row.credentialVersion !== request.credentialVersion) fail("STALE_CREDENTIALS", 409, "The publishing credentials changed before renewal.");
      const binding = { authorizationId: row.id, ownerId: row.userId, provider: row.provider, connectionMode: row.connectionMode,
        authorizationGeneration: row.generation, credentialVersion: row.credentialVersion, refreshDigest: fingerprint,
        leaseTokenHash: hash, leaseUntil: new Date(this.now().getTime() + this.leaseMs), startedAt: null, requestCount: 0 };
      await tx.socialCredentialRenewalLease.upsert({ where: { authorizationId: row.id }, create: binding, update: binding });
      return { kind: "owned", hash, snapshot };
    });
  }
  private async guard(tx: Prisma.TransactionClient, request: SocialRotatingRenewalRequest, hash: string) {
    const row = await this.grant(tx, request);
    const lease = await tx.socialCredentialRenewalLease.findFirst({ where: { authorizationId: request.authorizationId,
      ownerId: request.ownerId, provider: request.provider, connectionMode: this.mode, authorizationGeneration: request.generation,
      credentialVersion: request.credentialVersion, leaseTokenHash: hash, leaseUntil: { gt: this.now() } } });
    if (!row || !lease || row.credentialVersion !== request.credentialVersion)
      fail("STALE_CREDENTIALS", 409, "The publishing renewal lease is no longer current.");
    this.scopeGuard(row, request);
    return { row, lease };
  }
  private async failed(request: SocialRotatingRenewalRequest, hash: string, error: unknown, exchangeReturned: boolean): Promise<never> {
    const disposition = await this.transaction(async tx => {
      const lease = await tx.socialCredentialRenewalLease.findFirst({ where: { authorizationId: request.authorizationId, leaseTokenHash: hash } });
      if (!lease) return "unchanged" as const;
      const row = await this.grant(tx, request);
      if (!row || !row.refreshCiphertext) return "unchanged" as const;
      const token = this.vault.decrypt(row.refreshCiphertext, credentialContext(row.userId, row.id, "refresh"));
      if (lease.refreshDigest !== this.fingerprint(row, token)) return "unchanged" as const;
      // A returned credential response without the required HTTP guard violates the adapter protocol;
      // its old token may already have been consumed, even though no request was recorded.
      if ((!lease.startedAt && !exchangeReturned) || (lease.requestCount === 1 && error instanceof SocialRenewalExchangeError && error.exchangeRejected)) {
        await tx.socialCredentialRenewalLease.deleteMany({ where: { authorizationId: row.id, leaseTokenHash: hash } });
        return lease.startedAt !== null ? "safe-rejection" as const : "unchanged" as const;
      }
      await this.reconnect(tx, row); // Retain the uncertainty marker until this transition commits.
      return "reconnected" as const;
    });
    if (disposition === "reconnected") fail("RECONNECT_REQUIRED", 409, "The rotating refresh outcome could not be verified. Reconnect publishing access.");
    if (disposition === "safe-rejection" && error instanceof SocialRenewalExchangeError)
      throw new SocialProviderFailure(error.kind, true, error.retryAfterMs);
    throw error;
  }
  async renew(request: SocialRotatingRenewalRequest): Promise<VerifiedRotatedSocialGrant> {
    if (!["TIKTOK", "X", "LINKEDIN"].includes(request.provider) || !request.ownerId || !request.authorizationId ||
      !Number.isSafeInteger(request.generation) || request.generation < 1 || !Number.isSafeInteger(request.credentialVersion) || request.credentialVersion < 1 ||
      !Array.isArray(request.requiredScopes) || request.requiredScopes.length > 100 || request.requiredScopes.some(s => typeof s !== "string" || !s || s.length > 512))
      fail("INVALID_RENEWAL", 400, "Use a captured publishing authorization for renewal.");
    const claim = await this.claim(request);
    if (claim.kind === "adopted") return claim.grant;
    if (claim.kind === "busy") throw new SocialProviderFailure("TRANSIENT", true, 1000);
    if (claim.kind === "reconnect") fail("RECONNECT_REQUIRED", 409, "The previous refresh outcome is uncertain or its token expired. Reconnect publishing access.");
    const beforeRequest = async () => {
      await request.verifyCaller();
      const expired = await this.transaction(async tx => {
        const { row, lease } = await this.guard(tx, request, claim.hash);
        if (lease.requestCount === 0 && row.refreshExpiresAt && row.refreshExpiresAt <= this.now()) {
          await this.reconnect(tx, row); return true;
        }
        const changed = await tx.socialCredentialRenewalLease.updateMany({ where: { authorizationId: row.id, ownerId: row.userId,
          provider: row.provider, connectionMode: this.mode, authorizationGeneration: request.generation,
          credentialVersion: request.credentialVersion, leaseTokenHash: claim.hash, requestCount: lease.requestCount,
          leaseUntil: { gt: this.now() } }, data: { startedAt: lease.startedAt ?? this.now(), requestCount: { increment: 1 },
            leaseUntil: new Date(this.now().getTime() + this.leaseMs) } });
        if (changed.count !== 1) fail("STALE_CREDENTIALS", 409, "The publishing renewal lease changed before its request.");
        return false;
      });
      if (expired) fail("RECONNECT_REQUIRED", 409, "The refresh token expired before its exchange.");
    };
    let exchangeReturned = false;
    try {
      const renewed = await request.exchange(claim.snapshot, beforeRequest);
      exchangeReturned = true;
      const validDate = (value: unknown): value is Date => value instanceof Date && Number.isFinite(value.getTime()) && value > this.now();
      if (renewed.providerUserId !== claim.snapshot.providerUserId || typeof renewed.accessToken !== "string" || !renewed.accessToken || renewed.accessToken.length > 32768 ||
        typeof renewed.refreshToken !== "string" || !renewed.refreshToken || renewed.refreshToken.length > 32768 || !validDate(renewed.expiresAt) ||
        (renewed.refreshExpiresAt !== null && !validDate(renewed.refreshExpiresAt)) || !Array.isArray(renewed.scopes) || renewed.scopes.length > 100 ||
        renewed.scopes.some(s => typeof s !== "string" || !s || s.length > 512) || request.requiredScopes.some(s => !renewed.scopes.includes(s)))
        fail("RECONNECT_REQUIRED", 409, "The provider could not verify its rotated publishing credentials.");
      await this.transaction(async tx => {
        const { row, lease } = await this.guard(tx, request, claim.hash);
        if (!lease.startedAt || lease.requestCount < 1) fail("INVALID_RENEWAL_PROTOCOL", 502, "The provider did not guard its refresh exchange.");
        const changed = await tx.providerAuthorization.updateMany({ where: { id: row.id, userId: row.userId, provider: row.provider,
          capability: "SOCIAL", connectionMode: this.mode, generation: row.generation, credentialVersion: request.credentialVersion, status: "CONNECTED" },
          data: { accessCiphertext: this.vault.encrypt(renewed.accessToken, credentialContext(row.userId, row.id, "access")),
            refreshCiphertext: this.vault.encrypt(renewed.refreshToken, credentialContext(row.userId, row.id, "refresh")),
            expiresAt: renewed.expiresAt, refreshExpiresAt: renewed.refreshExpiresAt, scopes: [...new Set(renewed.scopes)], credentialVersion: { increment: 1 } } });
        if (changed.count !== 1) fail("STALE_CREDENTIALS", 409, "The publishing authorization changed during rotation.");
        await tx.socialCredentialRenewalLease.deleteMany({ where: { authorizationId: row.id, leaseTokenHash: claim.hash } });
        await tx.connectionAuditEvent.create({ data: { authorizationId: row.id, action: "SOCIAL_ROTATING_CREDENTIALS_RENEWED" } });
      });
      return renewed;
    } catch (error) { return this.failed(request, claim.hash, error, exchangeReturned); }
  }
}
