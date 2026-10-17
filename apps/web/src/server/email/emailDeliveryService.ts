import { randomBytes, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient, MessageSend, EmailConnection } from "../../generated/prisma/client";
import { CustomerAuth, type CustomerPrincipal } from "../auth/customerAuth";
import { CredentialVault } from "../security/credentialVault";
import { fail, SecurityError } from "../security/errors";
import { fields, object, text, sha256, timestamp, emailKey } from "../funnels/trackingValidation";
import { enqueueFunnelEvaluation } from "../funnels/funnelLifecycle";
import type { NormalizedTrackingEvent } from "../funnels/trackingTypes";
import { checkEmailEligibility, emailAddressDigest, emailCredentialContext, emailPayloadContext, emailJson,
  applyEmailOptOut, applyEmailSuppression, settleEmailMembership } from "./emailPolicy";
import { nextSendAt } from "./emailTiming";
import type { EmailProviderFactory, EmailEnvironment, EmailSendResult, VerifiedEmailWebhook, RetrievedEmail } from "./emailProvider";

type Tx = Prisma.TransactionClient;
const DAY = 86_400_000;
const summary = (send: MessageSend) => ({ id: send.id, membershipId: send.membershipId, revisionId: send.revisionId, stepId: send.stepId,
  status: send.status, deliveryState: send.deliveryState, dueAt: send.dueAt.toISOString(), expiresAt: send.expiresAt.toISOString(),
  acceptedAt: send.acceptedAt?.toISOString() ?? null, cancelRequestedAt: send.cancelRequestedAt?.toISOString() ?? null });
export type DispatchResult = { send: ReturnType<typeof summary>; outcome: "ACCEPTED" | "ALREADY_ACCEPTED" | "NOT_SUBMITTED" | "REJECTED" | "UNKNOWN";
  code?: string; nextEligibleAt?: string };

/** A committed local intent precedes every provider RPC. Provider calls never run within a transaction. */
export class EmailDeliveryService {
  private readonly now: () => Date;
  private readonly unsubscribeBaseUrl: string;
  constructor(private readonly db: PrismaClient, private readonly auth: CustomerAuth, private readonly vault: CredentialVault,
    private readonly providerFor: EmailProviderFactory, private readonly options: { now?: () => Date; liveEnabled: boolean; unsubscribeBaseUrl: string }) {
    this.now = options.now ?? (() => new Date());
    const url = new URL(options.unsubscribeBaseUrl);
    if (url.username || url.password || url.search || url.hash || url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
      fail("INVALID_EMAIL_CONFIGURATION", 500, "Configure an exact secure unsubscribe base URL.");
    this.unsubscribeBaseUrl = url.toString().replace(/\/$/, "");
  }
  private async session(tx: Tx, principal: CustomerPrincipal) {
    if (!await tx.customerSession.findFirst({ where: { id: principal.sessionId, userId: principal.userId, expiresAt: { gt: this.now() } } }))
      fail("UNAUTHENTICATED", 401, "Sign in to continue.");
  }
  private async owned(tx: Tx | PrismaClient, principal: CustomerPrincipal, sendId: string) {
    const send = await tx.messageSend.findFirst({ where: { id: sendId, ownerId: principal.userId } });
    if (!send) fail("NOT_FOUND", 404, "Email send not found."); return send;
  }
  private credentials(connection: EmailConnection): { apiKey: string; webhookSecret: string } {
    try {
      const value = JSON.parse(this.vault.decrypt(connection.credentialCiphertext, emailCredentialContext(connection)));
      if (typeof value.apiKey !== "string" || typeof value.webhookSecret !== "string") throw new Error();
      return value;
    } catch { return fail("EMAIL_CREDENTIALS_UNAVAILABLE", 409, "Email credentials are unavailable."); }
  }
  async createIntent(principal: CustomerPrincipal, value: unknown) {
    await this.auth.assertSession(principal); const input = object(value); fields(input, ["membershipId", "stepId"]);
    const membershipId = text(input.membershipId), stepId = input.stepId === undefined ? undefined : text(input.stepId);
    return this.db.$transaction(async tx => {
      await this.session(tx, principal);
      const membership = await tx.campaignMembership.findFirst({ where: { id: membershipId, ownerId: principal.userId } });
      if (!membership) fail("NOT_FOUND", 404, "Campaign membership not found.");
      const steps = await tx.campaignStep.findMany({ where: { revisionId: membership.revisionId }, orderBy: { position: "asc" } });
      if (steps.length !== 1 || (steps[0].wait as { kind?: string }).kind !== "IMMEDIATE" || stepId && steps[0].id !== stepId)
        fail("EMAIL_STEP_UNAVAILABLE", 409, "Manual sending supports the single immediate step of this revision.");
      const step = steps[0], previous = await tx.messageSend.findFirst({ where: { membershipId, stepId: step.id, iteration: 1 } });
      if (previous) return { send: summary(previous), existing: true };
      const now = this.now(), eligible = await checkEmailEligibility(tx, { membershipId, now, liveEnabled: this.options.liveEnabled, purpose: "DISPATCH" });
      if (!eligible.eligible) fail(eligible.code, 409, "This membership is not currently eligible for email.");
      const id = randomUUID(), token = randomBytes(32).toString("base64url"), unsubscribeUrl = `${this.unsubscribeBaseUrl}/${token}`;
      const htmlUrl = unsubscribeUrl.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
      const provider = this.providerFor(membership.environment as EmailEnvironment);
      if (provider.capabilities.environment !== membership.environment) fail("EMAIL_MODE_MISMATCH", 500, "The email adapter does not match this environment.");
      const request = provider.buildRequest({ from: { address: eligible.sender.address, ...(eligible.sender.name ? { name: eligible.sender.name } : {}) },
        to: eligible.recipient, ...(eligible.sender.replyTo ? { replyTo: eligible.sender.replyTo } : {}), subject: step.subject,
        ...(step.html ? { html: `${step.html}\n<p><a href="${htmlUrl}">Unsubscribe</a></p>` } : {}),
        ...(step.text ? { text: `${step.text}\n\nUnsubscribe: ${unsubscribeUrl}` } : {}), unsubscribeUrl, sendRef: id });
      if (sha256(request.body) !== request.requestDigest) fail("EMAIL_REQUEST_INVALID", 500, "The provider request fingerprint is invalid.");
      const dueAt = membership.startedAt, expiresAt = new Date(dueAt.getTime() + step.expiresAfterDueSeconds * 1000);
      const send = await tx.messageSend.create({ data: { id, ownerId: membership.ownerId, environment: membership.environment, membershipId,
        revisionId: membership.revisionId, stepId: step.id, connectionId: eligible.connection.id, senderId: eligible.sender.id, contactId: membership.contactId,
        recipientDigest: eligible.recipientDigest, subscriptionCategory: eligible.revision.subscriptionCategory,
        payloadCiphertext: this.vault.encrypt(request.body, emailPayloadContext({ id, ownerId: membership.ownerId, environment: membership.environment })),
        requestDigest: request.requestDigest, idempotencyKey: `launchpad-email:${id}`, dueAt, expiresAt,
        connectionGeneration: eligible.source.generation, membershipRevision: membership.revision, createdAt: now } });
      await tx.emailUnsubscribeToken.create({ data: { ownerId: send.ownerId, environment: send.environment, tokenHash: sha256(token),
        addressDigest: send.recipientDigest, category: send.subscriptionCategory, sendId: send.id, createdAt: now } });
      for (const reason of eligible.reasons) await tx.messageSendAttribution.create({ data: { ownerId: send.ownerId, environment: send.environment,
        sendId: send.id, membershipId, reasonId: reason.id, createdAt: now } });
      return { send: summary(send), existing: false };
    });
  }
  async get(principal: CustomerPrincipal, sendId: string) {
    await this.auth.assertSession(principal); const send = await this.owned(this.db, principal, sendId);
    const [attempts, receipts] = await Promise.all([
      this.db.deliveryAttempt.findMany({ where: { sendId }, orderBy: { number: "asc" } }),
      this.db.emailDeliveryReceipt.findMany({ where: { sendId }, orderBy: { receivedAt: "asc" }, take: 100 }),
    ]);
    return { send: summary(send), attempts: attempts.map(a => ({ id: a.id, number: a.number, startedAt: a.startedAt, completedAt: a.completedAt,
      outcome: a.outcome, code: a.errorCode })), receipts: receipts.map(r => ({ id: r.id, type: r.type, status: r.status, reason: r.reason,
      occurredAt: r.occurredAt, receivedAt: r.receivedAt })) };
  }
  async dispatch(principal: CustomerPrincipal, sendId: string): Promise<DispatchResult> { return this.submit(principal, sendId, false); }
  async retry(principal: CustomerPrincipal, sendId: string): Promise<DispatchResult> { return this.submit(principal, sendId, true); }
  private async submit(principal: CustomerPrincipal, sendId: string, retry: boolean): Promise<DispatchResult> {
    await this.auth.assertSession(principal);
    const prepared = await this.db.$transaction(async tx => {
      await this.session(tx, principal); const send = await this.owned(tx, principal, sendId), now = this.now();
      const blocked = (code: string, nextEligibleAt?: string): { result: DispatchResult } => ({ result: { send: summary(send), outcome: "NOT_SUBMITTED", code, ...(nextEligibleAt ? { nextEligibleAt } : {}) } });
      if (send.status === "ACCEPTED") return { result: { send: summary(send), outcome: "ALREADY_ACCEPTED" as const } };
      if (["UNKNOWN", "SUBMITTING"].includes(send.status)) return { result: { send: summary(send), outcome: "UNKNOWN" as const, code: "RECONCILIATION_REQUIRED" } };
      if (retry) {
        const previous = await tx.deliveryAttempt.findFirst({ where: { sendId }, orderBy: { number: "desc" } });
        if (send.status !== "FAILED" || previous?.outcome !== "REJECTED" || !send.nextAttemptAt) return blocked("RETRY_UNAVAILABLE");
        if (send.nextAttemptAt > now) return blocked("RETRY_NOT_DUE", send.nextAttemptAt.toISOString());
      } else if (send.status !== "PENDING") return blocked(send.status === "FAILED" ? "EXPLICIT_RETRY_REQUIRED" : "SEND_INELIGIBLE");
      if (send.idempotencyExpiresAt && now >= send.idempotencyExpiresAt) return blocked("IDEMPOTENCY_EXPIRED");
      const eligible = await checkEmailEligibility(tx, { membershipId: send.membershipId, now, liveEnabled: this.options.liveEnabled, purpose: "DISPATCH", sendId });
      if (!eligible.eligible) return blocked(eligible.code);
      if (send.firstSubmittedAt && (send.connectionGeneration !== eligible.source.generation)) return blocked("CONNECTION_CHANGED");
      const timing = nextSendAt(new Date(Math.max(send.dueAt.getTime(), now.getTime())).toISOString(),
        { ...(eligible.revision.sendWindow as { weekdays: number[]; startMinute: number; endMinute: number }), timeZone: eligible.revision.timeZone }, send.expiresAt.toISOString());
      if ("expired" in timing) { const updated = await tx.messageSend.update({ where: { id: sendId }, data: { status: "EXPIRED", revision: { increment: 1 } } });
        return { result: { send: summary(updated), outcome: "NOT_SUBMITTED" as const, code: "SEND_EXPIRED" } }; }
      if (Date.parse(timing.at) > now.getTime()) return blocked("SEND_WINDOW_CLOSED", timing.at);
      if (!send.payloadCiphertext) return blocked("PAYLOAD_UNAVAILABLE");
      const body = this.vault.decrypt(send.payloadCiphertext, emailPayloadContext(send));
      if (sha256(body) !== send.requestDigest) return blocked("REQUEST_CHANGED");
      const credentials = this.credentials(eligible.connection);
      if (!credentials.apiKey || !credentials.webhookSecret) return blocked("EMAIL_READINESS_REQUIRED");
      const previous = await tx.deliveryAttempt.findFirst({ where: { sendId }, orderBy: { number: "desc" } });
      const updated = await tx.messageSend.update({ where: { id: sendId }, data: { status: "SUBMITTING", revision: { increment: 1 },
        connectionGeneration: eligible.source.generation, membershipRevision: eligible.membership.revision, nextAttemptAt: null,
        firstSubmittedAt: send.firstSubmittedAt ?? now, idempotencyExpiresAt: send.idempotencyExpiresAt ?? new Date(now.getTime() + DAY) } });
      const attempt = await tx.deliveryAttempt.create({ data: { ownerId: send.ownerId, environment: send.environment, sendId, number: (previous?.number ?? 0) + 1,
        connectionGeneration: eligible.source.generation, credentialVersion: eligible.connection.credentialVersion,
        membershipRevision: eligible.membership.revision, sendRevision: updated.revision, startedAt: now, createdAt: now } });
      return { send: updated, attempt, credentials, body, connectionId: eligible.connection.id };
    });
    if ("result" in prepared) return prepared.result!;
    const { send, attempt, credentials, body } = prepared;
    let result: EmailSendResult, preconditionRejected = false;
    try {
      const provider = this.providerFor(send.environment as EmailEnvironment);
      if (provider.capabilities.environment !== send.environment) result = { kind: "NOT_SUBMITTED", code: "MODE_DISABLED" };
      else result = await provider.send({ environment: send.environment as EmailEnvironment, ...credentials, beforeRequest: async operation => {
        if (operation !== "SEND") fail("EMAIL_OPERATION_INVALID", 500, "Unexpected provider operation.");
        try { await this.db.$transaction(async tx => {
          await this.session(tx, principal);
          const current = await tx.messageSend.findUniqueOrThrow({ where: { id: send.id } });
          const eligible = await checkEmailEligibility(tx, { membershipId: send.membershipId, now: this.now(), liveEnabled: this.options.liveEnabled, purpose: "DISPATCH", sendId: send.id });
          if (!eligible.eligible || current.status !== "SUBMITTING" || current.revision !== attempt.sendRevision ||
            eligible.source.generation !== attempt.connectionGeneration || eligible.connection.credentialVersion !== attempt.credentialVersion ||
            eligible.membership.revision !== attempt.membershipRevision) fail("EMAIL_PRECONDITION_FAILED", 409, "Email eligibility changed before submission.");
          const timing = nextSendAt(this.now().toISOString(), { ...(eligible.revision.sendWindow as { weekdays: number[]; startMinute: number; endMinute: number }),
            timeZone: eligible.revision.timeZone }, current.expiresAt.toISOString());
          if ("expired" in timing || Date.parse(timing.at) > this.now().getTime()) fail("SEND_WINDOW_CLOSED", 409, "The send window is closed.");
        }); } catch (error) { preconditionRejected = true; throw error; }
      } }, { body, requestDigest: send.requestDigest, idempotencyKey: send.idempotencyKey,
        firstSubmittedAt: send.firstSubmittedAt!, idempotencyExpiresAt: send.idempotencyExpiresAt! });
    } catch { result = preconditionRejected ? { kind: "NOT_SUBMITTED", code: "PRECONDITION_FAILED" } : { kind: "UNKNOWN", code: "PROVIDER_UNCERTAIN" }; }
    return this.db.$transaction(async tx => {
      const current = await tx.messageSend.findUniqueOrThrow({ where: { id: send.id } }), now = this.now();
      const previousUnknown = await tx.deliveryAttempt.findFirst({ where: { sendId: send.id, id: { not: attempt.id }, outcome: "UNKNOWN" } });
      const attemptNow = await tx.deliveryAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
      let updated: MessageSend;
      if (result.kind === "ACCEPTED") {
        try { updated = await this.bindAccepted(tx, current, result.providerMessageId, now); }
        catch (error) {
          if (!(error instanceof SecurityError) || error.code !== "EMAIL_MAPPING_CONFLICT") throw error;
          result = { kind: "UNKNOWN", code: "INVALID_PROVIDER_RESPONSE" };
          updated = current.status === "ACCEPTED" ? current : await tx.messageSend.update({ where: { id: send.id }, data: { status: "UNKNOWN", revision: { increment: 1 } } });
        }
      } else if (current.status === "ACCEPTED") updated = current; // Positive racing reconciliation outranks a later uncertain response.
      else {
        const uncertain = result.kind === "UNKNOWN" || !!previousUnknown || attemptNow.outcome === "UNKNOWN";
        const retryAt = result.kind === "REJECTED" && result.retryable ? new Date(now.getTime() + Math.max(0, result.retryAfterMs ?? 60_000)) : null;
        updated = await tx.messageSend.update({ where: { id: send.id }, data: { status: uncertain ? "UNKNOWN" : current.cancelRequestedAt ? "CANCELLED" :
          result.kind === "NOT_SUBMITTED" ? "PENDING" : "FAILED", nextAttemptAt: retryAt, revision: { increment: 1 } } });
        if (!uncertain && result.kind === "REJECTED" && !result.retryable)
          await tx.campaignMembership.updateMany({ where: { id: send.membershipId, status: "ACTIVE" }, data: { status: "BLOCKED", revision: { increment: 1 } } });
      }
      // Finalize evidence only after validating the provider identity. A reported acceptance
      // with a conflicting mapping is ambiguous, while any earlier proven mapping stays intact.
      const outcome = result.kind === "ACCEPTED" ? "ACCEPTED" : result.kind === "UNKNOWN" ? "UNKNOWN" : result.kind === "NOT_SUBMITTED" ? "CANCELLED_BEFORE_SUBMIT" : "REJECTED";
      if (!attemptNow.completedAt) await tx.deliveryAttempt.update({ where: { id: attempt.id }, data: { outcome, completedAt: now, errorCode: "code" in result ? result.code : null } });
      await settleEmailMembership(tx, send.membershipId, now);
      return { send: summary(updated), outcome: updated.status === "ACCEPTED" ? "ACCEPTED" as const : result.kind, ...("code" in result ? { code: result.code } : {}) };
    });
  }
  private async bindAccepted(tx: Tx, send: MessageSend, providerMessageId: string, acceptedAt: Date) {
    const idDigest = sha256(providerMessageId);
    const other = await tx.messageSend.findFirst({ where: { connectionId: send.connectionId, providerMessageIdDigest: idDigest, id: { not: send.id } } });
    if (other || send.providerMessageIdDigest && send.providerMessageIdDigest !== idDigest) fail("EMAIL_MAPPING_CONFLICT", 409, "Provider acceptance conflicts with an existing send mapping.");
    const updated = await tx.messageSend.update({ where: { id: send.id }, data: { status: "ACCEPTED", acceptedAt: send.acceptedAt ?? acceptedAt,
      providerMessageId: send.redactedAt ? null : providerMessageId, providerMessageIdDigest: idDigest, nextAttemptAt: null, revision: { increment: 1 } } });
    await tx.emailDeliveryReceipt.updateMany({ where: { connectionId: send.connectionId, providerMessageIdDigest: idDigest, status: "UNMATCHED" },
      data: { status: "QUEUED", reason: null } });
    const membership = await tx.campaignMembership.findUniqueOrThrow({ where: { id: send.membershipId } });
    if (membership.status === "ACTIVE") {
      const steps = await tx.campaignStep.findMany({ where: { revisionId: membership.revisionId } });
      const accepted = await tx.messageSend.findMany({ where: { membershipId: send.membershipId, status: "ACCEPTED" } });
      if (steps.every(step => accepted.some(item => item.stepId === step.id)))
        await tx.campaignMembership.update({ where: { id: membership.id }, data: { status: "COMPLETED", revision: { increment: 1 } } });
    }
    return updated;
  }
  async reconcile(principal: CustomerPrincipal, sendId: string, value: unknown = {}) {
    await this.auth.assertSession(principal); const input = object(value); fields(input, ["providerMessageId"]);
    const candidateInput = input.providerMessageId === undefined ? undefined : text(input.providerMessageId, 100);
    const send = await this.owned(this.db, principal, sendId);
    if (!send.firstSubmittedAt || send.redactedAt || !send.payloadCiphertext) fail("RECONCILIATION_UNAVAILABLE", 409, "This send has no recoverable submission evidence.");
    const connection = await this.db.emailConnection.findUniqueOrThrow({ where: { id: send.connectionId } });
    const source = await this.db.trackingSource.findUniqueOrThrow({ where: { id: connection.sourceId } });
    const credentials = this.credentials(connection), body = this.vault.decrypt(send.payloadCiphertext, emailPayloadContext(send));
    if (sha256(body) !== send.requestDigest) fail("REQUEST_CHANGED", 409, "The saved email request could not be verified.");
    let candidate = send.providerMessageId ?? candidateInput;
    if (send.providerMessageId && candidateInput && candidateInput !== send.providerMessageId) fail("EMAIL_MAPPING_CONFLICT", 409, "This send already has a different provider identity.");
    if (!candidate) {
      const retained = await this.db.emailDeliveryReceipt.findMany({ where: { connectionId: connection.id, opaqueSendRef: send.id,
        status: "UNMATCHED", providerMessageId: { not: null } }, take: 20 });
      const candidates = [...new Set(retained.map(r => r.providerMessageId!))];
      if (candidates.length === 1) candidate = candidates[0];
    }
    const unresolved = async (code: string) => {
      const updated = await this.db.$transaction(async tx => {
        await this.session(tx, principal);
        const current = await this.owned(tx, principal, sendId), now = this.now();
        const stale = await tx.deliveryAttempt.findMany({ where: { sendId, outcome: "IN_FLIGHT", startedAt: { lte: new Date(now.getTime() - 60_000) } } });
        for (const attempt of stale) await tx.deliveryAttempt.update({ where: { id: attempt.id }, data: { outcome: "UNKNOWN", completedAt: now, errorCode: "PROCESS_INTERRUPTED" } });
        if (stale.length && current.status === "SUBMITTING") return tx.messageSend.update({ where: { id: sendId }, data: { status: "UNKNOWN", revision: { increment: 1 } } });
        return current;
      });
      return { send: summary(updated), outcome: "UNRESOLVED" as const, code };
    };
    if (!candidate) return unresolved("PROVIDER_ID_REQUIRED");
    const provider = this.providerFor(send.environment as EmailEnvironment);
    if (provider.capabilities.environment !== send.environment) fail("EMAIL_MODE_MISMATCH", 500, "The email adapter does not match this environment.");
    const retrieved = await provider.retrieve({ environment: send.environment as EmailEnvironment, ...credentials, beforeRequest: async operation => {
      if (operation !== "RETRIEVE") fail("EMAIL_OPERATION_INVALID", 500, "Unexpected provider operation.");
      await this.db.$transaction(async tx => {
        await this.session(tx, principal);
        const current = await this.owned(tx, principal, sendId), currentConnection = await tx.emailConnection.findUniqueOrThrow({ where: { id: connection.id } });
        const currentSource = await tx.trackingSource.findUniqueOrThrow({ where: { id: source.id } });
        if (current.redactedAt || !current.payloadCiphertext || currentSource.status === "DISCONNECTED" || currentSource.generation !== source.generation ||
          currentConnection.credentialVersion !== connection.credentialVersion || current.environment === "LIVE" && !this.options.liveEnabled)
          fail("EMAIL_RECONCILIATION_BLOCKED", 409, "Provider read access changed.");
      });
    } }, candidate);
    if (retrieved.kind !== "FOUND") return unresolved(retrieved.kind === "NOT_FOUND" ? "NO_POSITIVE_EVIDENCE" : retrieved.code);
    if (!this.matchesFrozen(send, body, candidate, retrieved.email)) return unresolved("PROVIDER_EVIDENCE_MISMATCH");
    return this.db.$transaction(async tx => {
      await this.session(tx, principal); const current = await this.owned(tx, principal, sendId), now = this.now();
      if (current.redactedAt || current.requestDigest !== send.requestDigest) fail("RECONCILIATION_UNAVAILABLE", 409, "The email was removed while verifying evidence.");
      await tx.deliveryAttempt.updateMany({ where: { sendId, outcome: "IN_FLIGHT", startedAt: { lte: new Date(now.getTime() - 60_000) } },
        data: { outcome: "UNKNOWN", completedAt: now, errorCode: "PROCESS_INTERRUPTED" } });
      const updated = await this.bindAccepted(tx, current, retrieved.email.providerMessageId, new Date(retrieved.email.createdAt));
      // Reconciliation preserves completed attempt outcomes, including UNKNOWN.
      await tx.trackingAudit.create({ data: { ownerId: send.ownerId, environment: send.environment, sourceId: source.id, actorId: principal.userId,
        action: "EMAIL_SEND_RECONCILED", reason: `send:${send.id};request:${send.requestDigest}`, createdAt: now } });
      await settleEmailMembership(tx, send.membershipId, now);
      return { send: summary(updated), outcome: "MATCHED" as const };
    });
  }
  private matchesFrozen(send: MessageSend, body: string, candidate: string, remote: RetrievedEmail) {
    const request = JSON.parse(body) as { from: string; to: string[]; subject: string; html?: string; text?: string; reply_to?: string };
    return remote.providerMessageId === candidate && remote.tags.launchpad_send === send.id && remote.from === request.from && remote.subject === request.subject
      && remote.to.length === 1 && emailKey(remote.to[0]) === emailKey(request.to[0]) && !remote.cc.length && !remote.bcc.length
      && (request.html === undefined || request.html === remote.html) && (request.text === undefined || request.text === remote.text)
      && JSON.stringify(remote.replyTo.map(emailKey)) === JSON.stringify(request.reply_to ? [emailKey(request.reply_to)] : [])
      && Date.parse(remote.createdAt) >= send.firstSubmittedAt!.getTime() - 300_000 && Date.parse(remote.createdAt) <= this.now().getTime() + 300_000;
  }
  async ingestWebhook(ingressToken: string, headers: Headers, rawBody: Uint8Array) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(ingressToken)) fail("NOT_FOUND", 404, "Email webhook not found.");
    const source = await this.db.trackingSource.findFirst({ where: { ingressTokenHash: sha256(ingressToken), provider: "RESEND" } });
    if (!source) fail("NOT_FOUND", 404, "Email webhook not found.");
    const connection = await this.db.emailConnection.findUniqueOrThrow({ where: { sourceId: source.id } }), credentials = this.credentials(connection);
    if (!credentials.webhookSecret) fail("EMAIL_WEBHOOK_UNCONFIGURED", 409, "The webhook signing secret has not been configured.");
    const provider = this.providerFor(source.environment as EmailEnvironment);
    if (provider.capabilities.environment !== source.environment) fail("EMAIL_MODE_MISMATCH", 500, "The email adapter does not match this environment.");
    const now = this.now(), event = provider.verifyWebhook({ rawBody, headers, webhookSecret: credentials.webhookSecret, now });
    const occurredAt = new Date(timestamp(event.occurredAt)), idDigest = event.providerMessageId ? sha256(event.providerMessageId) : null;
    const result = await this.db.$transaction(async tx => {
      const previous = await tx.emailDeliveryReceipt.findUnique({ where: { connectionId_providerDeliveryId: { connectionId: connection.id, providerDeliveryId: event.providerDeliveryId } } });
      if (previous) {
        const conflict = previous.rawPayloadDigest !== event.rawPayloadDigest;
        await tx.emailDeliveryReceipt.update({ where: { id: previous.id }, data: conflict ? { conflictCount: { increment: 1 },
          ...(["QUEUED", "UNMATCHED"].includes(previous.status) ? { status: "QUARANTINED", reason: "DELIVERY_CONFLICT" } : {}) } : { duplicateCount: { increment: 1 } } });
        return { accepted: true as const, receiptId: previous.id, duplicate: true, conflict };
      }
      const send = idDigest ? await tx.messageSend.findFirst({ where: { connectionId: connection.id, providerMessageIdDigest: idDigest } }) : null;
      const addressDigest = event.suppression || event.to.length === 1
        ? emailAddressDigest(connection.ownerId, connection.environment, event.suppression?.email ?? event.to[0]) : null;
      const deleted = addressDigest && await tx.emailSuppression.findFirst({ where: { ownerId: connection.ownerId, environment: connection.environment,
        addressDigest, reason: "CONTACT_DELETED", active: true } });
      // A privacy tombstone can redact an unbound receipt; it never establishes send/contact identity.
      const redacted = !!send?.redactedAt || !!deleted, reason = !event.supported ? "UNSUPPORTED_EVENT" : occurredAt.getTime() > now.getTime() + 300_000 ? "FUTURE_TIMESTAMP" : undefined;
      const receipt = await tx.emailDeliveryReceipt.create({ data: { ownerId: connection.ownerId, environment: connection.environment,
        connectionId: connection.id, connectionGeneration: source.generation, providerDeliveryId: event.providerDeliveryId,
        type: event.type, rawPayloadDigest: event.rawPayloadDigest, envelope: redacted ? {} : emailJson(event),
        providerMessageId: redacted ? null : event.providerMessageId, providerMessageIdDigest: idDigest,
        addressDigest: redacted ? null : addressDigest,
        sendId: redacted ? send?.id : undefined, opaqueSendRef: redacted ? null : event.tags.launchpad_send,
        verificationKeyVersion: connection.credentialVersion, status: redacted ? "REDACTED" : reason ? "QUARANTINED" : "QUEUED",
        reason, occurredAt, receivedAt: now, expiresAt: new Date(now.getTime() + 180 * DAY), createdAt: now } });
      return { accepted: true as const, receiptId: receipt.id, duplicate: false };
    });
    if ("conflict" in result && result.conflict) fail("DELIVERY_CONFLICT", 409, "This delivery identity was already used with different content.");
    return { accepted: result.accepted, receiptId: result.receiptId, duplicate: result.duplicate };
  }
  async processOnce() {
    return this.db.$transaction(async tx => {
      let receipt = await tx.emailDeliveryReceipt.findFirst({ where: { status: "QUEUED" }, orderBy: [{ receivedAt: "asc" }, { id: "asc" }] });
      if (!receipt) {
        const retained = await tx.emailDeliveryReceipt.findMany({ where: { status: "UNMATCHED", providerMessageIdDigest: { not: null } }, orderBy: { receivedAt: "asc" }, take: 100 });
        for (const candidate of retained) if (await tx.messageSend.findFirst({ where: { connectionId: candidate.connectionId, providerMessageIdDigest: candidate.providerMessageIdDigest } })) { receipt = candidate; break; }
      }
      if (!receipt) return null;
      const now = this.now(), event = receipt.envelope as unknown as VerifiedEmailWebhook;
      const connection = await tx.emailConnection.findUniqueOrThrow({ where: { id: receipt.connectionId } });
      const source = await tx.trackingSource.findUniqueOrThrow({ where: { id: connection.sourceId } });
      const complete = async (status: string, reason?: string, sendId?: string) => {
        await tx.emailDeliveryReceipt.update({ where: { id: receipt!.id }, data: { status, reason, sendId, processedAt: now } });
        return { receiptId: receipt!.id, status, ...(reason ? { reason } : {}) };
      };
      if (event.type === "suppression.added" || event.type === "suppression.removed") {
        if (!receipt.addressDigest || !event.suppression) return complete("QUARANTINED", "MISSING_SUPPRESSION_IDENTITY");
        if (event.type === "suppression.added") await applyEmailSuppression(tx, { ownerId: receipt.ownerId, environment: receipt.environment,
          addressDigest: receipt.addressDigest, category: "*", reason: "PROVIDER_SUPPRESSION", sourceId: source.id, receiptId: receipt.id, now,
          requestKey: `email-receipt:${receipt.id}:suppression`, requestDigest: sha256(JSON.stringify([receipt.rawPayloadDigest, "PROVIDER_SUPPRESSION"])) });
        return complete("MATCHED", event.type === "suppression.removed" ? "LOCAL_POLICY_UNCHANGED" : undefined);
      }
      if (!receipt.providerMessageIdDigest) return complete("QUARANTINED", "MISSING_MESSAGE_ID");
      const send = await tx.messageSend.findFirst({ where: { connectionId: connection.id, providerMessageIdDigest: receipt.providerMessageIdDigest } });
      if (!send) return complete("UNMATCHED", "PROVIDER_ID_NOT_BOUND");
      const contact = await tx.funnelContact.findUniqueOrThrow({ where: { id: send.contactId } });
      if (send.redactedAt || contact.deletedAt) {
        await tx.emailDeliveryReceipt.update({ where: { id: receipt.id }, data: { status: "REDACTED", sendId: send.id, envelope: {},
          providerMessageId: null, addressDigest: null, opaqueSendRef: null, processedAt: now } });
        return { receiptId: receipt.id, status: "REDACTED" };
      }
      if (event.to.length !== 1 || emailAddressDigest(send.ownerId, send.environment, event.to[0]) !== send.recipientDigest ||
        event.tags.launchpad_send && event.tags.launchpad_send !== send.id) return complete("QUARANTINED", "MESSAGE_IDENTITY_CONFLICT");
      const states: Record<string, string> = { "email.sent": "SENT", "email.delivery_delayed": "DELAYED", "email.delivered": "DELIVERED",
        "email.failed": "FAILED", "email.bounced": "BOUNCED", "email.complained": "COMPLAINED", "email.suppressed": "SUPPRESSED" };
      const order = ["UNKNOWN", "SENT", "DELAYED", "DELIVERED", "FAILED", "BOUNCED", "COMPLAINED", "SUPPRESSED"];
      const state = states[event.type];
      if (state && order.indexOf(state) > order.indexOf(send.deliveryState)) await tx.messageSend.update({ where: { id: send.id }, data: { deliveryState: state, revision: { increment: 1 } } });
      const suppression = event.type === "email.complained" ? "COMPLAINT" : event.type === "email.suppressed" ? "PROVIDER_SUPPRESSION" :
        event.type === "email.bounced" && event.bounce?.type?.toLowerCase() === "permanent" ? "HARD_BOUNCE" : undefined;
      if (suppression) await applyEmailSuppression(tx, { ownerId: send.ownerId, environment: send.environment, addressDigest: send.recipientDigest,
        category: "*", reason: suppression, sourceId: source.id, receiptId: receipt.id, now,
        requestKey: `email-receipt:${receipt.id}:suppression`, requestDigest: sha256(JSON.stringify([receipt.rawPayloadDigest, suppression])) });
      const membership = await tx.campaignMembership.findUniqueOrThrow({ where: { id: send.membershipId } });
      if (membership.scopeKind === "SUBJECT" && membership.subjectId) {
        const subject = await tx.funnelSubject.findUniqueOrThrow({ where: { id: membership.subjectId } });
        const mode = source.status === "ACTIVE" && source.generation === receipt.connectionGeneration ? "LIVE" : "BACKFILL";
        const normalized: NormalizedTrackingEvent = { type: event.type, dedupeKey: `email-receipt:${receipt.id}`, providerTopic: event.type,
          providerDeliveryId: event.providerDeliveryId, occurredAt: receipt.occurredAt.toISOString(), authority: "PROVIDER_VERIFIED",
          verification: `SVIX:${receipt.verificationKeyVersion}`, resource: { kind: "MESSAGE", id: receipt.providerMessageId! }, references: [],
          subjectKind: subject.kind as "CONTACT" | "SALES" | "PURCHASE", properties: { ...(state ? { deliveryState: state } : {}),
            sendId: send.id, campaignId: membership.campaignId, campaignRevisionId: send.revisionId, stepId: send.stepId } };
        const terminalFact = ["email.sent", "email.delivered", "email.bounced", "email.complained", "email.failed", "email.suppressed"].includes(event.type);
        let factId: string | undefined;
        if (terminalFact) {
          const key = `email:${source.id}:${send.id}:${event.type}`;
          const fact = await tx.trackingFact.upsert({ where: { ownerId_subjectId_key: { ownerId: send.ownerId, subjectId: subject.id, key } }, update: {},
            create: { ownerId: send.ownerId, environment: send.environment, subjectId: subject.id, key, type: event.type, authority: "PROVIDER_VERIFIED",
              occurredAt: receipt.occurredAt, attributes: emailJson({ sendId: send.id }), createdAt: now } });
          factId = fact.id; normalized.factKey = key;
        }
        const tracking = await tx.trackingEvent.create({ data: { ownerId: send.ownerId, environment: send.environment, sourceId: source.id,
          sourceGeneration: receipt.connectionGeneration, type: normalized.type, dedupeKey: normalized.dedupeKey,
          rawPayloadDigest: receipt.rawPayloadDigest, envelope: emailJson(normalized), ingestionMode: "LIVE", processingMode: mode,
          status: "MATCHED", subjectId: subject.id, contactId: send.contactId, factId, occurredAt: receipt.occurredAt,
          receivedAt: receipt.receivedAt, processedAt: now, expiresAt: receipt.expiresAt } });
        if (source.status === "ACTIVE") await enqueueFunnelEvaluation(tx, tracking, now);
      }
      return complete("MATCHED", undefined, send.id);
    });
  }
  async unsubscribeInfo(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { valid: false };
    return { valid: !!await this.db.emailUnsubscribeToken.findFirst({ where: { tokenHash: sha256(token), revokedAt: null } }) };
  }
  async unsubscribe(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) fail("NOT_FOUND", 404, "Unsubscribe link not found.");
    return this.db.$transaction(async tx => {
      const stored = await tx.emailUnsubscribeToken.findFirst({ where: { tokenHash: sha256(token), revokedAt: null } });
      if (!stored) fail("NOT_FOUND", 404, "Unsubscribe link not found.");
      const key = { ownerId: stored.ownerId, environment: stored.environment, addressDigest: stored.addressDigest, category: stored.category };
      const current = await tx.emailSubscription.findFirst({ where: key });
      const hold = await tx.emailSuppression.findFirst({ where: { ...key, reason: "OPT_OUT", active: true } });
      if (current?.state !== "OPTED_OUT" || !hold) await applyEmailOptOut(tx, { ...key, now: this.now(),
        requestKey: `unsubscribe:${stored.tokenHash}:${current?.revision ?? 0}`, requestDigest: sha256(JSON.stringify([stored.tokenHash, current?.revision ?? 0])) });
      return { accepted: true as const };
    });
  }
}
