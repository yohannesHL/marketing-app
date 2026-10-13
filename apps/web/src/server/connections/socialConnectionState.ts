import type { DestinationKind, Platform, PrismaClient } from "../../generated/prisma/client";
import { CustomerAuth, type CustomerPrincipal } from "../auth/customerAuth";
import { fail } from "../security/errors";
import { SOCIAL_DESTINATIONS } from "../social/validation";
import { cancelSocialDeliveries } from "../social/connectionLifecycle";

export type DiscoveredSocialDestination = {
  kind: DestinationKind; externalId: string; name: string; available: boolean;
  canRead: boolean; canWrite: "ALLOWED" | "DENIED";
  pageId?: string; tasks?: string[];
};

/** Public metadata is deliberately separate from private provider credentials. */
export class SocialConnectionState {
  constructor(private readonly db: PrismaClient, private readonly auth: CustomerAuth, private readonly now = () => new Date()) {}
  async select(principal: CustomerPrincipal, authorizationId: string, provider: Platform, version: number,
    destinationId: string, mode: "mock" | "live") {
    await this.auth.assertSession(principal);
    await this.db.$transaction(async (tx) => {
      const row = await tx.connectionDestination.findFirst({ where: { id: destinationId, authorizationId, available: true,
        authorization: { userId: principal.userId, provider, capability: "SOCIAL", status: "CONNECTED",
          credentialVersion: version, connectionMode: mode.toUpperCase() } } });
      if (!row || (row.metadata as { canWrite?: string } | null)?.canWrite !== "ALLOWED")
        fail("STALE_CREDENTIALS", 409, "The destination or its verified publishing access changed during selection.");
      await tx.connectionDestination.update({ where: { id: row.id }, data: { selected: true } });
      await tx.connectionAuditEvent.create({ data: { authorizationId, action: "SOCIAL_DESTINATION_SELECTED" } });
    });
  }
  async synchronize(principal: CustomerPrincipal, id: string, provider: Platform, version: number, rows: DiscoveredSocialDestination[]) {
    await this.auth.assertSession(principal);
    if (rows.length > 1000 || new Set(rows.map((row) => `${row.kind}:${row.externalId}`)).size !== rows.length ||
      rows.some((row) => !SOCIAL_DESTINATIONS[provider]?.includes(row.kind) || !/^[A-Za-z0-9_:.-]{1,256}$/.test(row.externalId) ||
        !row.name || row.name.length > 512 || typeof row.available !== "boolean" || typeof row.canRead !== "boolean" ||
        !["ALLOWED", "DENIED"].includes(row.canWrite) ||
        (row.pageId !== undefined && (provider !== "META" || !/^\d{1,64}$/.test(row.pageId))) ||
        (row.tasks !== undefined && (row.tasks.length > 20 || row.tasks.some((task) => !/^[A-Z_]{1,64}$/.test(task))))))
      fail("INVALID_DISCOVERY", 502, "Provider discovery returned unsupported social destinations.");
    await this.db.$transaction(async (tx) => {
      const grant = await tx.providerAuthorization.findFirst({ where: { id, userId: principal.userId, provider,
        capability: "SOCIAL", credentialVersion: version, status: "CONNECTED" } });
      if (!grant) fail("STALE_CREDENTIALS", 409, "The publishing connection changed during discovery.");
      const existing = await tx.connectionDestination.findMany({ where: { authorizationId: id } });
      const invalidated = existing.filter((item) => !rows.some((row) => row.kind === item.kind && row.externalId === item.externalId && row.available && row.canWrite === "ALLOWED"));
      await tx.connectionDestination.updateMany({ where: { id: { in: invalidated.map((item) => item.id) } },
        data: { available: false, selected: false, lastCheckedAt: this.now() } });
      for (const row of rows) {
        const data = { name: row.name, available: row.available, lastCheckedAt: this.now(),
          metadata: { canRead: row.canRead, canWrite: row.canWrite,
            ...(row.pageId ? { pageId: row.pageId } : {}), ...(row.tasks ? { tasks: row.tasks } : {}) } };
        await tx.connectionDestination.upsert({ where: { authorizationId_kind_externalId: { authorizationId: id, kind: row.kind, externalId: row.externalId } },
          create: { authorizationId: id, kind: row.kind, externalId: row.externalId, ...data },
          update: { ...data, ...(!row.available || row.canWrite !== "ALLOWED" ? { selected: false } : {}) } });
      }
      await cancelSocialDeliveries(tx, [id], "DESTINATION_ACCESS_CHANGED", this.now(), invalidated.map((item) => item.id));
      await tx.connectionAuditEvent.create({ data: { authorizationId: id, action: "SOCIAL_DESTINATIONS_CHECKED" } });
    });
  }
}
