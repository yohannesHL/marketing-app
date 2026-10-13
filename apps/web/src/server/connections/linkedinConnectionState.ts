import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import { CustomerAuth, digest, type CustomerPrincipal } from "../auth/customerAuth";
import { fail } from "../security/errors";
import { cancelSocialDeliveries } from "../social/connectionLifecycle";
export type LinkedInGrantSnapshot = {
  authorizationId: string; providerUserId: string; credentialVersion: number; generation: number;
  mode: "mock" | "live"; refreshExpiresAt: Date | null;
};
/** Private fences bind each SDK HTTP request to an owned current grant or claimed OAuth attempt. */
export class LinkedInConnectionState {
  constructor(private readonly db: PrismaClient, private readonly auth: CustomerAuth, private readonly now = () => new Date()) {}
  private async session(tx: Prisma.TransactionClient, principal: CustomerPrincipal) {
    if (!await tx.customerSession.findFirst({ where: { id: principal.sessionId, userId: principal.userId, expiresAt: { gt: this.now() } } }))
      fail("UNAUTHENTICATED", 401, "Sign in to continue.");
  }
  async snapshot(principal: CustomerPrincipal, id: string, credentialVersion: number, mode: "mock" | "live"): Promise<LinkedInGrantSnapshot> {
    await this.auth.assertSession(principal);
    return this.db.$transaction(async tx => {
      await this.session(tx, principal);
      const row = await tx.providerAuthorization.findFirst({ where: { id, userId: principal.userId, provider: "LINKEDIN", capability: "SOCIAL",
        credentialVersion, connectionMode: mode.toUpperCase(), status: "CONNECTED" } });
      if (!row || !row.accessCiphertext) fail("STALE_CREDENTIALS", 409, "The LinkedIn publishing authorization changed.");
      return { authorizationId: id, providerUserId: row.providerUserId, credentialVersion, generation: row.generation, mode, refreshExpiresAt: row.refreshExpiresAt };
    });
  }
  async verifyCurrent(principal: CustomerPrincipal, snapshot: LinkedInGrantSnapshot, allowExpired = false) {
    await this.db.$transaction(async tx => {
      await this.session(tx, principal);
      const row = await tx.providerAuthorization.findFirst({ where: { id: snapshot.authorizationId, userId: principal.userId, provider: "LINKEDIN", capability: "SOCIAL",
        providerUserId: snapshot.providerUserId, credentialVersion: snapshot.credentialVersion, generation: snapshot.generation,
        connectionMode: snapshot.mode.toUpperCase(), status: "CONNECTED" } });
      if (!row || !row.accessCiphertext) fail("STALE_CREDENTIALS", 409, "The LinkedIn publishing authorization changed.");
      if (!allowExpired && (!row.expiresAt || row.expiresAt.getTime() <= this.now().getTime() + 60000))
        fail("RECONNECT_REQUIRED", 409, "Renew LinkedIn access before checking the author.");
    });
  }
  async verifyExchange(principal: CustomerPrincipal, state: string, claim: string, redirectUri: string) {
    await this.db.$transaction(async tx => {
      await this.session(tx, principal);
      const attempt = await tx.oAuthAttempt.findFirst({ where: { stateHash: digest(state), exchangeClaimHash: digest(claim), userId: principal.userId,
        sessionId: principal.sessionId, provider: "LINKEDIN", capability: "SOCIAL", redirectUri, consumedAt: null, expiresAt: { gt: this.now() } } });
      if (!attempt) fail("INVALID_OAUTH_STATE", 400, "The LinkedIn connection attempt expired or changed. Start again.");
    });
  }
  async invalidateAuthor(principal: CustomerPrincipal, snapshot: LinkedInGrantSnapshot, destinationId: string) {
    await this.db.$transaction(async tx => {
      await this.session(tx, principal);
      const destination = await tx.connectionDestination.findFirst({ where: { id: destinationId, authorizationId: snapshot.authorizationId,
        authorization: { userId: principal.userId, provider: "LINKEDIN", capability: "SOCIAL", providerUserId: snapshot.providerUserId,
          connectionMode: snapshot.mode.toUpperCase(), generation: snapshot.generation, credentialVersion: snapshot.credentialVersion, status: "CONNECTED" } } });
      if (!destination) fail("STALE_CREDENTIALS", 409, "The LinkedIn author changed during its access check.");
      const metadata = destination.metadata && typeof destination.metadata === "object" && !Array.isArray(destination.metadata) ? destination.metadata as Prisma.JsonObject : {};
      await tx.connectionDestination.update({ where: { id: destination.id }, data: { available: false, selected: false,
        metadata: { ...metadata, canRead: false, canWrite: "DENIED" }, lastCheckedAt: this.now() } });
      await cancelSocialDeliveries(tx, [snapshot.authorizationId], "DESTINATION_ACCESS_CHANGED", this.now(), [destination.id]);
      await tx.connectionAuditEvent.create({ data: { authorizationId: snapshot.authorizationId, action: "SOCIAL_DESTINATION_ACCESS_DENIED" } });
    });
  }
}
