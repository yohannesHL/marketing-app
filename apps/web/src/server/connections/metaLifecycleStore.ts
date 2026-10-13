import { randomBytes } from "node:crypto";
import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import { digest } from "../auth/customerAuth";
import { prisma } from "../prisma/client";
import { fail } from "../security/errors";

type CallbackEvent = { eventId: string; issuedAt?: number };

function eraseProviderData(value: unknown, ids: Set<string>, allMeta: boolean): unknown {
  if (typeof value === "string" && ids.has(value)) return undefined;
  if (Array.isArray(value))
    return value.map((child) => allMeta && child === "META" ? undefined : eraseProviderData(child, ids, allMeta))
      .filter((child) => child !== undefined);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if ((typeof object.destinationId === "string" && ids.has(object.destinationId)) ||
      (typeof object.authorizationId === "string" && ids.has(object.authorizationId)) ||
      (allMeta && object.platform === "META")) return undefined;
    return Object.fromEntries(Object.entries(object).flatMap(([key, child]) => {
      if (allMeta && key === "META") return [];
      const cleaned = eraseProviderData(child, ids, allMeta);
      return cleaned === undefined ? [] : [[key, cleaned]];
    }));
  }
  return value;
}

/** Called only after verification with this environment's Meta app secret. */
export class MetaLifecycleStore {
  private readonly connectionMode: "MOCK" | "LIVE";
  private readonly origin: string;
  constructor(private readonly db: PrismaClient, config: { origin: string; mode: "mock" | "live" },
    private readonly now = () => new Date()) {
    const url = new URL(config.origin);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))))
      fail("INVALID_CONFIG", 503, "Configure a secure application origin for deletion receipts.");
    this.origin = url.origin;
    this.connectionMode = config.mode === "mock" ? "MOCK" : "LIVE";
  }

  private identity(subject: string, action: string, event?: CallbackEvent) {
    if (!/^\d{1,64}$/.test(subject)) fail("INVALID_CALLBACK", 400, "Invalid provider callback identity.");
    if (event && !/^[a-f0-9]{64}$/.test(event.eventId))
      fail("INVALID_CALLBACK", 400, "Invalid provider callback identifier.");
    const now = this.now();
    const issuedAt = event?.issuedAt;
    if (issuedAt !== undefined && (!Number.isFinite(issuedAt) || issuedAt < 0 || issuedAt * 1000 > now.getTime() + 300_000))
      fail("INVALID_CALLBACK", 400, "Invalid provider callback timestamp.");
    return {
      key: digest(`META:${this.connectionMode}:${action}:${event?.eventId ?? randomBytes(32).toString("hex")}`),
      subjectDigest: digest(`META:${subject}`),
      // Provider timestamps have second precision. Cover that entire second so
      // fractional local timestamps cannot let earlier consent evade revocation.
      occurredAt: issuedAt === undefined ? now : new Date(Math.floor(issuedAt) * 1000 + 999),
      now,
    };
  }

  private async revoke(tx: Prisma.TransactionClient, subject: string, identity: ReturnType<MetaLifecycleStore["identity"]>) {
    const unique = { provider: "META" as const, connectionMode: this.connectionMode, subjectDigest: identity.subjectDigest };
    const fence = await tx.providerRevocationFence.findUnique({ where: { provider_connectionMode_subjectDigest: unique } });
    if (!fence || fence.revokedAt < identity.occurredAt)
      await tx.providerRevocationFence.upsert({ where: { provider_connectionMode_subjectDigest: unique },
        create: { ...unique, revokedAt: identity.occurredAt }, update: { revokedAt: identity.occurredAt } });
    const grants = await tx.providerAuthorization.findMany({ where: {
      provider: "META", connectionMode: this.connectionMode, externalGrantId: subject,
      OR: [{ authorizedAt: null }, { authorizedAt: { lte: identity.occurredAt } }],
    }, include: { destinations: { select: { id: true, externalId: true } } } });
    const ids = grants.map((g) => g.id);
    await tx.providerAuthorization.updateMany({ where: { id: { in: ids } }, data: {
      status: "REVOKED", accessCiphertext: null, refreshCiphertext: null, expiresAt: null,
      disconnectedAt: identity.now, generation: { increment: 1 }, credentialVersion: { increment: 1 },
    } });
    if (grants.length)
      await tx.oAuthAttempt.updateMany({ where: { consumedAt: null, createdAt: { lte: identity.occurredAt },
        OR: grants.map((g) => ({ userId: g.userId, provider: g.provider, capability: g.capability })),
      }, data: { consumedAt: identity.now, verifierCiphertext: null } });
    await tx.connectionDestination.updateMany({ where: { authorizationId: { in: ids } }, data: { selected: false } });
    await tx.connectionOperation.updateMany({ where: {
      destination: { authorizationId: { in: ids } }, status: { in: ["PENDING", "RUNNING"] },
    }, data: { status: "CANCELLED", completedAt: identity.now } });
    for (const id of ids)
      await tx.connectionAuditEvent.create({ data: { authorizationId: id, action: "PROVIDER_REVOKED" } });
    return grants;
  }

  async deauthorize(subject: string, event?: CallbackEvent) {
    const identity = this.identity(subject, "DEAUTHORIZE", event);
    await this.db.$transaction(async (tx) => {
      if (await tx.providerLifecycleEvent.findUnique({ where: { id: identity.key } })) return;
      await this.revoke(tx, subject, identity);
      await tx.providerLifecycleEvent.create({ data: {
        id: identity.key, provider: "META", connectionMode: this.connectionMode,
        subjectDigest: identity.subjectDigest, action: "DEAUTHORIZE", receivedAt: identity.now,
      } });
    });
  }

  async deleteData(subject: string, event?: CallbackEvent) {
    const identity = this.identity(subject, "DELETE", event);
    const id = await this.db.$transaction(async (tx) => {
      const previous = await tx.providerLifecycleEvent.findUnique({ where: { id: identity.key } });
      if (previous?.receiptId) return previous.receiptId;
      const grants = await this.revoke(tx, subject, identity);
      const grantIds = grants.map((g) => g.id);
      const identifiers = new Set(grants.flatMap((g) => [g.id, ...g.destinations.map((d) => d.id)]));
      const affected = { platform: "META" as const, connectionMode: this.connectionMode,
        authorizationId: { in: grantIds } };
      const executions = await tx.adProxyExecution.findMany({ where: { invocations: { some: affected } },
        select: { id: true, requestPayload: true, responsePayload: true } });
      await tx.adPlatformInvocation.deleteMany({ where: affected });
      for (const execution of executions) {
        const remaining = await tx.adPlatformInvocation.findMany({ where: { executionId: execution.id }, select: { platform: true } });
        if (!remaining.length) {
          await tx.adProxyExecution.delete({ where: { id: execution.id } });
          continue;
        }
        const allMeta = remaining.every((invocation) => invocation.platform !== "META");
        const cleaned = eraseProviderData(execution.responsePayload, identifiers, allMeta) ?? {};
        const responsePayload = cleaned && typeof cleaned === "object" && !Array.isArray(cleaned)
          ? { ...cleaned, providerDataRemoved: true }
          : { data: cleaned, providerDataRemoved: true };
        await tx.adProxyExecution.update({ where: { id: execution.id }, data: {
          requestPayload: (eraseProviderData(execution.requestPayload, identifiers, allMeta) ?? {}) as Prisma.InputJsonValue,
          responsePayload: responsePayload as Prisma.InputJsonValue,
        } });
      }
      // Cascades erase the known Meta destinations, queued operations and retained
      // connection audit/metadata. Independent provider grants are untouched.
      await tx.providerAuthorization.deleteMany({ where: { id: { in: grants.map((g) => g.id) } } });
      const receipt = randomBytes(16).toString("hex");
      await tx.providerDeletionReceipt.create({ data: {
        id: receipt, provider: "META", connectionMode: this.connectionMode,
        status: "COMPLETED", requestedAt: identity.now, completedAt: identity.now,
      } });
      await tx.providerLifecycleEvent.create({ data: {
        id: identity.key, provider: "META", connectionMode: this.connectionMode,
        subjectDigest: identity.subjectDigest, action: "DELETE", receivedAt: identity.now, receiptId: receipt,
      } });
      return receipt;
    });
    return { url: `${this.origin}/api/connections/meta/deletion-status/${id}`, confirmation_code: id };
  }

  async receipt(id: string) {
    if (!/^[a-f0-9]{32}$/.test(id)) fail("NOT_FOUND", 404, "Deletion request not found.");
    const receipt = await this.db.providerDeletionReceipt.findFirst({ where: {
      id, provider: "META", connectionMode: this.connectionMode,
    }, select: { status: true } });
    if (!receipt) fail("NOT_FOUND", 404, "Deletion request not found.");
    return receipt;
  }
}

export function metaLifecycleStore() {
  return new MetaLifecycleStore(prisma, {
    origin: process.env.APP_ORIGIN ?? "",
    mode: process.env.CONNECTION_MODE === "mock" ? "mock" : "live",
  });
}
