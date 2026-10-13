import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import { CustomerAuth, digest, type CustomerPrincipal } from "../auth/customerAuth";
import { creatorVersion, type TikTokCreator } from "../providers/tiktok";
import { fail } from "../security/errors";
export type TikTokGrantSnapshot = { authorizationId: string; providerUserId: string; credentialVersion: number; generation: number; mode: "mock" | "live" };
/** Trusted creator evidence never comes from an HTTP request body. */
export class TikTokCreatorState {
  constructor(private readonly db: PrismaClient, private readonly auth: CustomerAuth, private readonly now = () => new Date()) {}
  private async session(tx: Prisma.TransactionClient, principal: CustomerPrincipal) {
    const session = await tx.customerSession.findFirst({ where: { id: principal.sessionId, userId: principal.userId, expiresAt: { gt: this.now() } } });
    if (!session) fail("UNAUTHENTICATED", 401, "Sign in to continue.");
  }
  async snapshot(principal: CustomerPrincipal, authorizationId: string, credentialVersion: number, mode: "mock" | "live", reconnect = false): Promise<TikTokGrantSnapshot> {
    await this.auth.assertSession(principal);
    return this.db.$transaction(async (tx) => {
      await this.session(tx, principal);
      const grant = await tx.providerAuthorization.findFirst({ where: { id: authorizationId, userId: principal.userId, provider: "TIKTOK", capability: "SOCIAL",
        credentialVersion, connectionMode: mode.toUpperCase(), ...(!reconnect ? { status: "CONNECTED" } : {}) } });
      if (!grant) fail("STALE_CREDENTIALS", 409, "The TikTok publishing authorization changed.");
      return { authorizationId, providerUserId: grant.providerUserId, credentialVersion, generation: grant.generation, mode };
    });
  }
  private async fence(tx: Prisma.TransactionClient, principal: CustomerPrincipal, snapshot: TikTokGrantSnapshot) {
    await this.session(tx, principal);
    const grant = await tx.providerAuthorization.findFirst({ where: { id: snapshot.authorizationId, userId: principal.userId, provider: "TIKTOK", capability: "SOCIAL",
      providerUserId: snapshot.providerUserId, credentialVersion: snapshot.credentialVersion, generation: snapshot.generation,
      connectionMode: snapshot.mode.toUpperCase(), status: "CONNECTED" } });
    if (!grant) fail("STALE_CREDENTIALS", 409, "The TikTok publishing authorization changed.");
    return grant;
  }
  async verifyCurrent(principal: CustomerPrincipal, snapshot: TikTokGrantSnapshot) {
    await this.db.$transaction(async (tx) => { await this.fence(tx, principal, snapshot); });
  }
  async verifyExchange(principal: CustomerPrincipal, state: string, claimToken: string, redirectUri: string) {
    await this.db.$transaction(async (tx) => {
      await this.session(tx, principal);
      const attempt = await tx.oAuthAttempt.findFirst({ where: { stateHash: digest(state), exchangeClaimHash: digest(claimToken), userId: principal.userId,
        sessionId: principal.sessionId, provider: "TIKTOK", capability: "SOCIAL", redirectUri, consumedAt: null, expiresAt: { gt: this.now() } } });
      if (!attempt) fail("INVALID_OAUTH_STATE", 400, "The connection attempt is invalid or expired. Start again.");
    });
  }
  async persist(principal: CustomerPrincipal, snapshot: TikTokGrantSnapshot, creator: TikTokCreator) {
    const levels = ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"];
    if (!creator || creator.openId !== snapshot.providerUserId || !/^[A-Za-z0-9_.~-]{1,128}$/.test(creator.openId) ||
      [creator.username, creator.nickname].some((name) => typeof name !== "string" || !name || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) ||
      !Array.isArray(creator.privacyLevels) || !creator.privacyLevels.length || creator.privacyLevels.some((level) => !levels.includes(level)) ||
      new Set(creator.privacyLevels).size !== creator.privacyLevels.length || [creator.commentDisabled, creator.duetDisabled, creator.stitchDisabled].some((value) => typeof value !== "boolean") ||
      !Number.isSafeInteger(creator.maxDurationSeconds) || creator.maxDurationSeconds < 1 || creator.maxDurationSeconds > 3600 ||
      creator.version !== creatorVersion(creator)) fail("INVALID_DISCOVERY", 502, "TikTok returned unsupported creator settings.");
    const trusted = { openId: creator.openId, username: creator.username, nickname: creator.nickname, privacyLevels: [...creator.privacyLevels].sort(),
      commentDisabled: creator.commentDisabled, duetDisabled: creator.duetDisabled, stitchDisabled: creator.stitchDisabled,
      maxDurationSeconds: creator.maxDurationSeconds, version: creator.version, authorizationId: snapshot.authorizationId,
      authorizationGeneration: snapshot.generation, checkedAt: this.now().toISOString() };
    await this.db.$transaction(async (tx) => {
      await this.fence(tx, principal, snapshot);
      const destination = await tx.connectionDestination.findUnique({ where: { authorizationId_kind_externalId: { authorizationId: snapshot.authorizationId,
        kind: "TIKTOK_PROFILE", externalId: creator.openId } } });
      if (!destination || !destination.available) fail("STALE_CREDENTIALS", 409, "Refresh this TikTok destination before continuing.");
      const previous = destination.metadata && typeof destination.metadata === "object" && !Array.isArray(destination.metadata) ? destination.metadata as Record<string, Prisma.JsonValue> : {};
      await tx.connectionDestination.update({ where: { id: destination.id }, data: { metadata: { ...previous, tiktokCreator: trusted } } });
    });
  }
}
