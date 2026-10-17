import type { Prisma } from "../../generated/prisma/client";
import { fail } from "../security/errors";
import { emailKey, sha256 } from "../funnels/trackingValidation";

type Tx = Prisma.TransactionClient;
type Owned = { id: string; ownerId: string; environment: string };
export const emailAddressDigest = (ownerId: string, environment: string, address: string) =>
  sha256(JSON.stringify(["launchpad-email-address-v1", ownerId, environment, emailKey(address)]));
export const emailCredentialContext = (connection: Owned) => JSON.stringify(["email-credentials-v1", connection.ownerId, connection.environment, connection.id]);
export const emailPayloadContext = (send: Owned) => JSON.stringify(["email-request-v1", send.ownerId, send.environment, send.id]);
export const emailJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

/** No provider calls: every caller uses this inside its current-state transaction. */
export async function checkEmailEligibility(tx: Tx, input: {
  membershipId: string; now: Date; liveEnabled: boolean; purpose: "ENROL" | "DISPATCH"; sendId?: string;
}) {
  const blocked = (code: string) => ({ eligible: false as const, code });
  const membership = await tx.campaignMembership.findUnique({ where: { id: input.membershipId } });
  if (!membership || membership.endedAt || membership.status !== "ACTIVE") return blocked("MEMBERSHIP_INACTIVE");
  const campaign = await tx.marketingCampaign.findUniqueOrThrow({ where: { id: membership.campaignId } });
  if (campaign.status !== "ACTIVE" || campaign.category !== "EMAIL") return blocked("CAMPAIGN_INACTIVE");
  if (!(input.purpose === "ENROL" ? campaign.enrolmentEnabled : campaign.dispatchEnabled))
    return blocked(input.purpose === "ENROL" ? "ENROLMENT_PAUSED" : "DISPATCH_PAUSED");
  const revision = await tx.campaignRevision.findUniqueOrThrow({ where: { id: membership.revisionId } });
  const contact = await tx.funnelContact.findUniqueOrThrow({ where: { id: membership.contactId } });
  if (contact.deletedAt || !contact.email) return blocked("RECIPIENT_UNAVAILABLE");
  const recipientDigest = emailAddressDigest(membership.ownerId, membership.environment, contact.email);
  if (recipientDigest !== membership.addressDigest) return blocked("RECIPIENT_CHANGED");
  if (membership.subjectId) {
    const subject = await tx.funnelSubject.findUnique({ where: { id: membership.subjectId } });
    if (!subject || subject.contactId !== contact.id) return blocked("SUBJECT_RECIPIENT_CHANGED");
  }
  const reasons = await tx.campaignMembershipReason.findMany({ where: { membershipId: membership.id, endedAt: null, kind: "MANUAL" } });
  if (!reasons.length) return blocked("NO_ELIGIBLE_REASON");
  const policy = { ownerId: membership.ownerId, environment: membership.environment, addressDigest: recipientDigest };
  if (await tx.emailSuppression.findFirst({ where: { ...policy, active: true, category: { in: ["*", revision.subscriptionCategory] } } }))
    return blocked("RECIPIENT_SUPPRESSED");
  const subscription = await tx.emailSubscription.findFirst({ where: { ...policy, category: revision.subscriptionCategory } });
  if (subscription?.state !== "OPTED_IN") return blocked("CONSENT_REQUIRED");
  const sender = await tx.emailSender.findUniqueOrThrow({ where: { id: revision.senderId } });
  const connection = await tx.emailConnection.findUniqueOrThrow({ where: { id: sender.connectionId } });
  const source = await tx.trackingSource.findUniqueOrThrow({ where: { id: connection.sourceId } });
  if (source.status !== "ACTIVE") return blocked("EMAIL_CONNECTION_UNAVAILABLE");
  if (source.environment === "LIVE" && !input.liveEnabled) return blocked("EMAIL_LIVE_DISABLED");
  const readiness = sender.readiness as { ready?: boolean; generation?: number; credentialVersion?: number; checkedAt?: string };
  const age = input.now.getTime() - Date.parse(readiness.checkedAt ?? "");
  if (sender.status !== "VERIFIED" || !readiness.ready || readiness.generation !== source.generation ||
    readiness.credentialVersion !== connection.credentialVersion || !Number.isFinite(age) || age < 0 || age > 900_000)
    return blocked("EMAIL_READINESS_REQUIRED");
  if (input.sendId) {
    const send = await tx.messageSend.findUnique({ where: { id: input.sendId } });
    if (!send || send.membershipId !== membership.id || send.connectionId !== connection.id || send.senderId !== sender.id ||
      send.revisionId !== revision.id || send.recipientDigest !== recipientDigest || send.cancelRequestedAt || send.redactedAt)
      return blocked("SEND_INELIGIBLE");
  }
  return { eligible: true as const, membership, campaign, revision, contact, source, connection, sender, reasons,
    recipient: contact.email, recipientDigest };
}

/** A stopped/finished scope remains occupied until all possible remote acceptance is resolved. */
export async function settleEmailMembership(tx: Tx, membershipId: string, now: Date) {
  const membership = await tx.campaignMembership.findUnique({ where: { id: membershipId } });
  if (!membership || membership.endedAt || !["STOPPED", "COMPLETED"].includes(membership.status)) return;
  const sends = await tx.messageSend.findMany({ where: { membershipId }, select: { id: true, status: true } });
  if (sends.some(send => ["SUBMITTING", "UNKNOWN"].includes(send.status))) return;
  if (await tx.deliveryAttempt.findFirst({ where: { sendId: { in: sends.map(send => send.id) }, outcome: "IN_FLIGHT" } })) return;
  await tx.campaignMembership.update({ where: { id: membershipId }, data: { endedAt: now, revision: { increment: 1 } } });
}

export async function stopEmailMembership(tx: Tx, membershipId: string, reason: string, now: Date) {
  const membership = await tx.campaignMembership.findUnique({ where: { id: membershipId } });
  if (!membership || membership.endedAt) return;
  await tx.campaignMembership.update({ where: { id: membershipId }, data: { status: "STOPPED", stoppedAt: membership.stoppedAt ?? now,
    stopReason: membership.stopReason ?? reason, revision: { increment: 1 } } });
  await tx.campaignMembershipReason.updateMany({ where: { membershipId, endedAt: null }, data: { endedAt: now, endReason: reason } });
  await tx.messageSend.updateMany({ where: { membershipId, status: { in: ["PENDING", "CLAIMED", "BLOCKED", "FAILED"] } },
    data: { status: "CANCELLED", cancelRequestedAt: now, revision: { increment: 1 } } });
  await tx.messageSend.updateMany({ where: { membershipId, status: { in: ["SUBMITTING", "UNKNOWN", "ACCEPTED"] }, cancelRequestedAt: null },
    data: { cancelRequestedAt: now, revision: { increment: 1 } } });
  await settleEmailMembership(tx, membershipId, now);
}

type PolicyInput = { ownerId: string; environment: string; addressDigest: string; category: string;
  requestKey: string; requestDigest: string; sourceId?: string; receiptId?: string; actorId?: string; provenance?: unknown; now: Date };
async function audit(tx: Tx, input: PolicyInput, action: string, reason: string, provenance: unknown = input.provenance ?? {}) {
  const previous = await tx.emailPolicyAudit.findFirst({ where: { ownerId: input.ownerId, environment: input.environment, requestKey: input.requestKey } });
  if (previous) {
    if (previous.requestDigest !== input.requestDigest) fail("IDEMPOTENCY_CONFLICT", 409, "This policy command was used for another request.");
    return false;
  }
  await tx.emailPolicyAudit.create({ data: { ownerId: input.ownerId, environment: input.environment, addressDigest: input.addressDigest,
    category: input.category, requestKey: input.requestKey, requestDigest: input.requestDigest, sourceId: input.sourceId,
    receiptId: input.receiptId, actorId: input.actorId, action, reason, provenance: emailJson(provenance), createdAt: input.now } });
  return true;
}
export const recordEmailPolicyAudit = audit;

async function cancelAddressWork(tx: Tx, input: PolicyInput, reason: string) {
  const memberships = await tx.campaignMembership.findMany({ where: { ownerId: input.ownerId, environment: input.environment,
    addressDigest: input.addressDigest, endedAt: null } });
  for (const membership of memberships) {
    const revision = await tx.campaignRevision.findUniqueOrThrow({ where: { id: membership.revisionId } });
    if (input.category === "*" || revision.subscriptionCategory === input.category)
      await stopEmailMembership(tx, membership.id, reason, input.now);
  }
}

export async function applyEmailSuppression(tx: Tx, input: PolicyInput & {
  reason: "HARD_BOUNCE" | "COMPLAINT" | "PROVIDER_SUPPRESSION" | "ADMIN" | "CONTACT_DELETED" | "OPT_OUT";
}) {
  if (!await audit(tx, input, "SUPPRESS", input.reason)) return;
  const key = { ownerId: input.ownerId, environment: input.environment, addressDigest: input.addressDigest, category: input.category, reason: input.reason };
  const previous = await tx.emailSuppression.findFirst({ where: key });
  if (previous) await tx.emailSuppression.update({ where: { id: previous.id }, data: { active: true, revokedAt: null } });
  else await tx.emailSuppression.create({ data: { ...key, createdAt: input.now } });
  await cancelAddressWork(tx, input, input.reason);
}

export async function applyEmailOptOut(tx: Tx, input: PolicyInput) {
  if (!await audit(tx, input, "OPT_OUT", "OPT_OUT")) return;
  const key = { ownerId: input.ownerId, environment: input.environment, addressDigest: input.addressDigest, category: input.category };
  const subscription = await tx.emailSubscription.findFirst({ where: key });
  if (subscription) await tx.emailSubscription.update({ where: { id: subscription.id }, data: { state: "OPTED_OUT", changedAt: input.now,
    revision: { increment: 1 }, provenance: emailJson({ source: "EXPLICIT_OPT_OUT", at: input.now.toISOString() }) } });
  else await tx.emailSubscription.create({ data: { ...key, state: "OPTED_OUT", changedAt: input.now,
    provenance: emailJson({ source: "EXPLICIT_OPT_OUT", at: input.now.toISOString() }), createdAt: input.now } });
  const hold = await tx.emailSuppression.findFirst({ where: { ...key, reason: "OPT_OUT" } });
  if (hold) await tx.emailSuppression.update({ where: { id: hold.id }, data: { active: true, revokedAt: null } });
  else await tx.emailSuppression.create({ data: { ...key, reason: "OPT_OUT", createdAt: input.now } });
  await cancelAddressWork(tx, input, "OPT_OUT");
}

/** Called in the same transaction as contact erasure, before unlinking tracking subjects. */
export async function eraseEmailContact(tx: Tx, contactId: string, now: Date) {
  const contact = await tx.funnelContact.findUniqueOrThrow({ where: { id: contactId } });
  const memberships = await tx.campaignMembership.findMany({ where: { contactId } });
  const digests = new Set(memberships.map(membership => membership.addressDigest));
  if (contact.email) digests.add(emailAddressDigest(contact.ownerId, contact.environment, contact.email));
  for (const addressDigest of digests) {
    const key = { ownerId: contact.ownerId, environment: contact.environment, addressDigest };
    await applyEmailSuppression(tx, { ...key, category: "*", reason: "CONTACT_DELETED", now,
      requestKey: `delete:${contactId}:${addressDigest}`, requestDigest: sha256(JSON.stringify([contactId, addressDigest])) });
    await tx.emailSubscription.updateMany({ where: key, data: { state: "UNKNOWN", changedAt: now,
      provenance: {}, revision: { increment: 1 } } });
    await tx.emailPolicyAudit.updateMany({ where: { ...key, redactedAt: null }, data: { provenance: {}, reason: "REDACTED", redactedAt: now } });
  }
  await tx.campaignMembershipReason.updateMany({ where: { membershipId: { in: memberships.map(m => m.id) }, redactedAt: null },
    data: { note: null, redactedAt: now } });
  await tx.emailDeliveryReceipt.updateMany({ where: { ownerId: contact.ownerId, environment: contact.environment,
    addressDigest: { in: [...digests] }, status: { not: "REDACTED" } },
    data: { envelope: {}, providerMessageId: null, addressDigest: null, opaqueSendRef: null, status: "REDACTED" } });
  const sends = await tx.messageSend.findMany({ where: { contactId, redactedAt: null } });
  for (const send of sends) {
    await tx.messageSend.update({ where: { id: send.id }, data: { payloadCiphertext: null, providerMessageId: null,
      ...(send.status === "SUBMITTING" ? { status: "UNKNOWN", revision: { increment: 1 } } : {}),
      providerMessageIdDigest: send.providerMessageIdDigest ?? (send.providerMessageId ? sha256(send.providerMessageId) : null), redactedAt: now } });
    await tx.emailDeliveryReceipt.updateMany({ where: { sendId: send.id, status: { not: "REDACTED" } },
      data: { envelope: {}, providerMessageId: null, addressDigest: null, opaqueSendRef: null, status: "REDACTED" } });
  }
}
