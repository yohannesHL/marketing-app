import type { PrismaClient } from "../../generated/prisma/client";

const DAY = 86_400_000;
/** Bounded privacy maintenance. Keep dedupe/suppression tombstones and unresolved external effects. */
export async function pruneEmailEvidence(db: PrismaClient, now = new Date(), options: { sendDays?: number } = {}) {
  const sendDays = options.sendDays ?? 365;
  if (!Number.isInteger(sendDays) || sendDays < 1 || sendDays > 3650) throw new Error("Invalid email retention period.");
  return db.$transaction(async tx => {
    let receipts = 0, sends = 0;
    // Filter pinned connections before the batch limit so an old uncertain send cannot starve other owners.
    const candidates = await tx.emailDeliveryReceipt.findMany({ where: { expiresAt: { lte: now }, status: { in: ["MATCHED", "UNMATCHED", "QUARANTINED"] },
      connection: { sends: { none: { OR: [{ status: { in: ["SUBMITTING", "UNKNOWN"] } },
        { attempts: { some: { outcome: "IN_FLIGHT" } } }] } } } }, orderBy: [{ expiresAt: "asc" }, { id: "asc" }], take: 200 });
    for (const receipt of candidates) {
      await tx.emailDeliveryReceipt.update({ where: { id: receipt.id }, data: { envelope: {}, providerMessageId: null,
        addressDigest: null, opaqueSendRef: null, status: "REDACTED", processedAt: receipt.processedAt ?? now } });
      receipts++;
    }
    const cutoff = new Date(now.getTime() - sendDays * DAY);
    const finished = await tx.messageSend.findMany({ where: { createdAt: { lte: cutoff }, redactedAt: null,
      status: { in: ["ACCEPTED", "FAILED", "CANCELLED", "EXPIRED", "SUPPRESSED"] },
      membership: { endedAt: { not: null } }, connection: { receipts: { none: { status: "QUEUED" } } }, attempts: { none: { outcome: "IN_FLIGHT" } } }, orderBy: { createdAt: "asc" }, take: 200 });
    for (const send of finished) {
      await tx.messageSend.update({ where: { id: send.id }, data: { payloadCiphertext: null, providerMessageId: null, redactedAt: now } });
      await tx.emailDeliveryReceipt.updateMany({ where: { sendId: send.id, status: { not: "REDACTED" } },
        data: { envelope: {}, providerMessageId: null, addressDigest: null, opaqueSendRef: null, status: "REDACTED" } });
      sends++;
    }
    const policy = await tx.emailPolicyAudit.findMany({ where: { createdAt: { lte: cutoff }, redactedAt: null }, select: { id: true }, take: 200 });
    await tx.emailPolicyAudit.updateMany({ where: { id: { in: policy.map(item => item.id) } }, data: { provenance: {}, reason: "REDACTED", redactedAt: now } });
    const reasons = await tx.campaignMembershipReason.findMany({ where: { endedAt: { lte: cutoff }, redactedAt: null }, select: { id: true }, take: 200 });
    await tx.campaignMembershipReason.updateMany({ where: { id: { in: reasons.map(item => item.id) } }, data: { note: null, redactedAt: now } });
    return { receipts, sends, policy: policy.length, reasons: reasons.length };
  });
}
