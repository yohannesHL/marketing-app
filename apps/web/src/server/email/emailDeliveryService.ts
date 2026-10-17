import { randomBytes, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient, MessageSend, EmailConnection, CampaignStep } from "../../generated/prisma/client";
import { CustomerAuth, type CustomerPrincipal } from "../auth/customerAuth";
import { CredentialVault } from "../security/credentialVault";
import { fail, SecurityError } from "../security/errors";
import { fields, object, text, sha256, timestamp, emailKey } from "../funnels/trackingValidation";
import { enqueueFunnelEvaluation } from "../funnels/funnelLifecycle";
import type { NormalizedTrackingEvent } from "../funnels/trackingTypes";
import { checkEmailEligibility, emailAddressDigest, emailCredentialContext, emailPayloadContext, emailJson,
  applyEmailOptOut, applyEmailSuppression, settleEmailMembership } from "./emailPolicy";
import { nextSendAt } from "./emailTiming";
import { ensureCurrentStepTx, readResolvedStepTx, syncStepFromSendTx, checkStepEvidenceTx } from "./campaignStepService";
import type { EmailProviderFactory, EmailEnvironment, EmailSendResult, VerifiedEmailWebhook, RetrievedEmail } from "./emailProvider";

type Tx = Prisma.TransactionClient;
const DAY = 86_400_000, LEASE_MS = 120_000, MAX_ATTEMPTS = 5;
const backoff = (attempt: number) => Math.min(3_600_000, 60_000 * 2 ** Math.max(0, attempt - 1));
type Eligible = Extract<Awaited<ReturnType<typeof checkEmailEligibility>>, { eligible: true }>;
export type EmailSendLease = Readonly<{ sendId: string; token: string; operation: "SEND" | "RECONCILE" }>;
export type StepIntentResult = { kind: "CREATED" | "EXISTING"; sendId: string; stepExecutionId: string }
  | { kind: "DEFERRED" | "BLOCKED" | "EXPIRED"; code: string; nextWakeAt?: string };
type SubmissionAuthority = { kind: "CUSTOMER"; principal: CustomerPrincipal } | { kind: "WORKER"; lease: EmailSendLease };
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
    const result = await this.db.$transaction(async tx => {
      await this.session(tx, principal);
      const membership = await tx.campaignMembership.findFirst({ where: { id: membershipId, ownerId: principal.userId } });
      if (!membership) fail("NOT_FOUND", 404, "Campaign membership not found.");
      const execution = await ensureCurrentStepTx(tx, membershipId, this.now());
      if (execution) {
        if (stepId && stepId !== execution.stepId) return { blocked: "EMAIL_STEP_NOT_CURRENT" };
        const prepared = await this.createStepIntentTx(tx, execution.id);
        if ("code" in prepared) return { blocked: prepared.code };
        return { send: summary(await tx.messageSend.findUniqueOrThrow({ where: { id: prepared.sendId } })), existing: prepared.kind === "EXISTING" };
      }
      const steps = await tx.campaignStep.findMany({ where: { revisionId: membership.revisionId }, orderBy: { position: "asc" } });
      if (steps.length !== 1 || (steps[0].wait as { kind?: string }).kind !== "IMMEDIATE" || stepId && steps[0].id !== stepId)
        fail("EMAIL_STEP_UNAVAILABLE", 409, "Manual sending supports the single immediate step of this revision.");
      const step = steps[0], previous = await tx.messageSend.findFirst({ where: { membershipId, stepId: step.id, iteration: 1 } });
      if (previous) return { send: summary(previous), existing: true };
      const now = this.now(), eligible = await checkEmailEligibility(tx, { membershipId, now, liveEnabled: this.options.liveEnabled, purpose: "DISPATCH" });
      if (!eligible.eligible) fail(eligible.code, 409, "This membership is not currently eligible for email.");
      const send = await this.freezeIntentTx(tx, eligible, step, membership.startedAt, new Date(membership.startedAt.getTime() + step.expiresAfterDueSeconds * 1000));
      return { send: summary(send), existing: false };
    });
    if ("blocked" in result) fail(result.blocked!, 409, "The current campaign step is not ready for email.");
    return result;
  }
  private async freezeIntentTx(tx: Tx, eligible: Eligible, step: CampaignStep, dueAt: Date, expiresAt: Date, iteration = 1) {
    const membership = eligible.membership, membershipId = membership.id, now = this.now();
    const id = randomUUID(), token = randomBytes(32).toString("base64url"), unsubscribeUrl = `${this.unsubscribeBaseUrl}/${token}`;
    const htmlUrl = unsubscribeUrl.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
    const provider = this.providerFor(membership.environment as EmailEnvironment);
    if (provider.capabilities.environment !== membership.environment) fail("EMAIL_MODE_MISMATCH", 500, "The email adapter does not match this environment.");
    const request = provider.buildRequest({ from: { address: eligible.sender.address, ...(eligible.sender.name ? { name: eligible.sender.name } : {}) },
      to: eligible.recipient, ...(eligible.sender.replyTo ? { replyTo: eligible.sender.replyTo } : {}), subject: step.subject,
      ...(step.html ? { html: `${step.html}\n<p><a href="${htmlUrl}">Unsubscribe</a></p>` } : {}),
      ...(step.text ? { text: `${step.text}\n\nUnsubscribe: ${unsubscribeUrl}` } : {}), unsubscribeUrl, sendRef: id });
    if (sha256(request.body) !== request.requestDigest) fail("EMAIL_REQUEST_INVALID", 500, "The provider request fingerprint is invalid.");
    const send = await tx.messageSend.create({ data: { id, ownerId: membership.ownerId, environment: membership.environment, membershipId,
      revisionId: membership.revisionId, stepId: step.id, iteration, connectionId: eligible.connection.id, senderId: eligible.sender.id, contactId: membership.contactId,
      recipientDigest: eligible.recipientDigest, subscriptionCategory: eligible.revision.subscriptionCategory,
      payloadCiphertext: this.vault.encrypt(request.body, emailPayloadContext({ id, ownerId: membership.ownerId, environment: membership.environment })),
      requestDigest: request.requestDigest, idempotencyKey: `launchpad-email:${id}`, dueAt, expiresAt,
      connectionGeneration: eligible.source.generation, membershipRevision: membership.revision, createdAt: now } });
    await tx.emailUnsubscribeToken.create({ data: { ownerId: send.ownerId, environment: send.environment, tokenHash: sha256(token),
      addressDigest: send.recipientDigest, category: send.subscriptionCategory, sendId: send.id, createdAt: now } });
    for (const reason of eligible.reasons) await tx.messageSendAttribution.create({ data: { ownerId: send.ownerId, environment: send.environment,
      sendId: send.id, membershipId, reasonId: reason.id, createdAt: now } });
    return send;
  }
  private async attributeTx(tx: Tx, send: MessageSend, eligible: Eligible) {
    for (const reason of eligible.reasons) await tx.messageSendAttribution.upsert({ where: { sendId_reasonId: { sendId: send.id, reasonId: reason.id } }, update: {},
      create: { ownerId: send.ownerId, environment: send.environment, sendId: send.id, membershipId: send.membershipId, reasonId: reason.id, createdAt: this.now() } });
  }
  private async executionTx(tx: Tx, send: MessageSend, required: boolean, sending = true) {
    const execution = await tx.campaignStepExecution.findFirst({ where: { sendId: send.id } });
    if (!execution) { if (required) fail("EMAIL_AUTOMATION_NOT_STARTED", 409, "This send has no scheduled execution authority."); return null; }
    if (execution.status !== "SEND_PENDING" || execution.redactedAt || execution.membershipId !== send.membershipId || execution.revisionId !== send.revisionId ||
      execution.stepId !== send.stepId || execution.iteration !== send.iteration || execution.ownerId !== send.ownerId || execution.environment !== send.environment ||
      execution.dueAt?.getTime() !== send.dueAt.getTime() || execution.expiresAt?.getTime() !== send.expiresAt.getTime())
      fail("EMAIL_STEP_CHANGED", 409, "The current campaign step no longer authorizes this send.");
    if (sending) {
      const evidence = await checkStepEvidenceTx(tx, execution);
      if (!evidence.valid) fail(evidence.code, 409, "The campaign wait evidence no longer authorizes sending.");
    }
    return execution;
  }
  private async createStepIntentTx(tx: Tx, executionId: string): Promise<StepIntentResult> {
    const now = this.now(), resolved = await readResolvedStepTx(tx, executionId, now);
    if ("code" in resolved) return { ...resolved, nextWakeAt: resolved.nextWakeAt?.toISOString() };
    const { execution, step, dueAt, expiresAt } = resolved;
    if (resolved.kind === "EXISTING") return { kind: "EXISTING", sendId: execution.sendId!, stepExecutionId: execution.id };
    const eligible = await checkEmailEligibility(tx, { membershipId: execution.membershipId, now, liveEnabled: this.options.liveEnabled, purpose: "DISPATCH" });
    if (!eligible.eligible) return { kind: "DEFERRED", code: eligible.code };
    if (eligible.membership.revisionId !== execution.revisionId) return { kind: "BLOCKED", code: "EMAIL_STEP_CHANGED" };
    const previous = await tx.messageSend.findFirst({ where: { membershipId: execution.membershipId, stepId: execution.stepId, iteration: execution.iteration } });
    const send = previous ?? await this.freezeIntentTx(tx, eligible, step, dueAt, expiresAt, execution.iteration);
    if (send.dueAt.getTime() !== dueAt.getTime() || send.expiresAt.getTime() !== expiresAt.getTime())
      fail("EMAIL_STEP_CHANGED", 409, "The existing send has different immutable timing.");
    await tx.campaignStepExecution.update({ where: { id: execution.id }, data: { sendId: send.id, status: "SEND_PENDING", reason: null, nextWakeAt: null, revision: { increment: 1 } } });
    return { kind: previous ? "EXISTING" : "CREATED", sendId: send.id, stepExecutionId: execution.id };
  }
  async createStepIntent(executionId: string): Promise<StepIntentResult> {
    return this.db.$transaction(tx => this.createStepIntentTx(tx, executionId));
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
  private verifyLease(send: MessageSend, lease: EmailSendLease, operation: EmailSendLease["operation"]) {
    if (lease.sendId !== send.id || lease.operation !== operation || send.leaseTokenHash !== sha256(lease.token) || !send.leaseUntil || send.leaseUntil <= this.now())
      fail("EMAIL_LEASE_LOST", 409, "The email work lease is no longer current.");
  }
  async claimSend(sendId?: string): Promise<EmailSendLease | null> { return this.claim(sendId, "SEND"); }
  async claimReconciliation(sendId?: string): Promise<EmailSendLease | null> { return this.claim(sendId, "RECONCILE"); }
  private async claim(sendId: string | undefined, operation: EmailSendLease["operation"]): Promise<EmailSendLease | null> {
    const now = this.now();
    const hints = await this.db.messageSend.findMany({ where: { ...(sendId ? { id: sendId } : {}), redactedAt: null,
      status: operation === "SEND" ? { in: ["PENDING", "FAILED"] } : "UNKNOWN",
      stepExecution: { is: { status: "SEND_PENDING", redactedAt: null } },
      AND: [{ OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] }, { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }],
      ...(operation === "SEND" ? { dueAt: { lte: now }, expiresAt: { gt: now }, cancelRequestedAt: null } : { reconcileAttemptCount: { lt: MAX_ATTEMPTS } }) },
      orderBy: [{ dueAt: "asc" }, { id: "asc" }], take: 20 });
    for (const hint of hints) {
      const lease = await this.db.$transaction(async tx => {
        const send = await tx.messageSend.findUniqueOrThrow({ where: { id: hint.id } });
        if (send.revision !== hint.revision || send.leaseUntil && send.leaseUntil > this.now()) return null;
        try { await this.executionTx(tx, send, true, operation === "SEND"); }
        catch (error) {
          if (!(error instanceof SecurityError)) throw error;
          await tx.messageSend.update({ where: { id: send.id }, data: { nextAttemptAt: new Date(this.now().getTime() + 60_000) } });
          await tx.campaignStepExecution.updateMany({ where: { sendId: send.id, status: "SEND_PENDING" }, data: { reason: error.code } });
          return null;
        }
        if (operation === "SEND") {
          const last = await tx.deliveryAttempt.findFirst({ where: { sendId: send.id }, orderBy: { number: "desc" } });
          const code = (last?.number ?? 0) >= MAX_ATTEMPTS ? "RETRY_EXHAUSTED" : send.idempotencyExpiresAt && send.idempotencyExpiresAt <= this.now() ? "IDEMPOTENCY_EXPIRED" :
            send.status === "FAILED" && (last?.outcome !== "REJECTED" || !send.nextAttemptAt) ? "RETRY_UNAVAILABLE" : undefined;
          if (code) {
            await tx.messageSend.update({ where: { id: send.id }, data: { status: "BLOCKED", nextAttemptAt: null, revision: { increment: 1 } } });
            await tx.campaignStepExecution.updateMany({ where: { sendId: send.id, status: "SEND_PENDING" }, data: { reason: code } });
            return null;
          }
        } else if (!await this.reconciliationCandidate(tx, send)) {
          // Missing evidence is not a provider read attempt. Defer it so this bounded page
          // cannot keep hiding later sends whose provider IDs have become available.
          await tx.messageSend.update({ where: { id: send.id }, data: {
            nextAttemptAt: new Date(this.now().getTime() + 60_000), reconcileErrorCode: "PROVIDER_ID_REQUIRED" } });
          return null;
        }
        const token = randomBytes(32).toString("base64url");
        const changed = await tx.messageSend.updateMany({ where: { id: send.id, revision: hint.revision, status: hint.status, leaseTokenHash: hint.leaseTokenHash },
          data: { leaseTokenHash: sha256(token), leaseUntil: new Date(this.now().getTime() + LEASE_MS), revision: { increment: 1 } } });
        return changed.count ? { sendId: send.id, token, operation } : null;
      });
      if (lease) return lease;
    }
    return null;
  }
  async dispatchClaimed(lease: EmailSendLease): Promise<DispatchResult> {
    const send = await this.db.messageSend.findUniqueOrThrow({ where: { id: lease.sendId } });
    try { return await this.submit({ kind: "WORKER", lease }, send.id, send.status === "FAILED"); }
    finally { await this.db.messageSend.updateMany({ where: { id: send.id, leaseTokenHash: sha256(lease.token), status: { not: "SUBMITTING" } },
      data: { leaseTokenHash: null, leaseUntil: null, nextAttemptAt: new Date(this.now().getTime() + 60_000) } }); }
  }
  async dispatch(principal: CustomerPrincipal, sendId: string): Promise<DispatchResult> { return this.submit({ kind: "CUSTOMER", principal }, sendId, false); }
  async retry(principal: CustomerPrincipal, sendId: string): Promise<DispatchResult> { return this.submit({ kind: "CUSTOMER", principal }, sendId, true); }
  private async submit(authority: SubmissionAuthority, sendId: string, retry: boolean): Promise<DispatchResult> {
    if (authority.kind === "CUSTOMER") await this.auth.assertSession(authority.principal);
    const prepared = await this.db.$transaction(async tx => {
      if (authority.kind === "CUSTOMER") await this.session(tx, authority.principal);
      const send = authority.kind === "CUSTOMER" ? await this.owned(tx, authority.principal, sendId) : await tx.messageSend.findUniqueOrThrow({ where: { id: sendId } }), now = this.now();
      if (authority.kind === "WORKER") this.verifyLease(send, authority.lease, "SEND");
      const blocked = (code: string, nextEligibleAt?: string): { result: DispatchResult } => ({ result: { send: summary(send), outcome: "NOT_SUBMITTED", code, ...(nextEligibleAt ? { nextEligibleAt } : {}) } });
      if (send.status === "ACCEPTED") return { result: { send: summary(send), outcome: "ALREADY_ACCEPTED" as const } };
      if (["UNKNOWN", "SUBMITTING"].includes(send.status)) return { result: { send: summary(send), outcome: "UNKNOWN" as const, code: "RECONCILIATION_REQUIRED" } };
      if (authority.kind === "CUSTOMER" && send.leaseUntil && send.leaseUntil > now) return blocked("EMAIL_LEASE_HELD");
      try { await this.executionTx(tx, send, authority.kind === "WORKER"); }
      catch (error) {
        if (!(error instanceof SecurityError) || error.status >= 500) throw error;
        return blocked(error.code);
      }
      if (retry) {
        const previous = await tx.deliveryAttempt.findFirst({ where: { sendId }, orderBy: { number: "desc" } });
        if ((previous?.number ?? 0) >= MAX_ATTEMPTS) return blocked("RETRY_EXHAUSTED");
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
        await syncStepFromSendTx(tx, sendId, now);
        return { result: { send: summary(updated), outcome: "NOT_SUBMITTED" as const, code: "SEND_EXPIRED" } }; }
      if (Date.parse(timing.at) > now.getTime()) return blocked("SEND_WINDOW_CLOSED", timing.at);
      if (!send.payloadCiphertext) return blocked("PAYLOAD_UNAVAILABLE");
      const body = this.vault.decrypt(send.payloadCiphertext, emailPayloadContext(send));
      if (sha256(body) !== send.requestDigest) return blocked("REQUEST_CHANGED");
      const credentials = this.credentials(eligible.connection);
      if (!credentials.apiKey || !credentials.webhookSecret) return blocked("EMAIL_READINESS_REQUIRED");
      await this.attributeTx(tx, send, eligible);
      const previous = await tx.deliveryAttempt.findFirst({ where: { sendId }, orderBy: { number: "desc" } });
      const lease = authority.kind === "WORKER" ? authority.lease : { sendId, operation: "SEND" as const, token: randomBytes(32).toString("base64url") };
      const updated = await tx.messageSend.update({ where: { id: sendId }, data: { status: "SUBMITTING", revision: { increment: 1 },
        connectionGeneration: eligible.source.generation, membershipRevision: eligible.membership.revision, nextAttemptAt: null,
        leaseTokenHash: sha256(lease.token), leaseUntil: new Date(now.getTime() + LEASE_MS),
        firstSubmittedAt: send.firstSubmittedAt ?? now, idempotencyExpiresAt: send.idempotencyExpiresAt ?? new Date(now.getTime() + DAY) } });
      const attempt = await tx.deliveryAttempt.create({ data: { ownerId: send.ownerId, environment: send.environment, sendId, number: (previous?.number ?? 0) + 1,
        connectionGeneration: eligible.source.generation, credentialVersion: eligible.connection.credentialVersion,
        membershipRevision: eligible.membership.revision, sendRevision: updated.revision, leaseTokenHash: sha256(lease.token), startedAt: now, createdAt: now } });
      return { send: updated, attempt, credentials, body, lease, connectionId: eligible.connection.id };
    });
    if ("result" in prepared) {
      if (authority.kind === "WORKER") {
        const permanent = ["CONNECTION_CHANGED", "REQUEST_CHANGED", "PAYLOAD_UNAVAILABLE", "IDEMPOTENCY_EXPIRED", "RETRY_EXHAUSTED"].includes(prepared.result!.code ?? "");
        await this.db.$transaction(async tx => {
          await tx.messageSend.updateMany({ where: { id: sendId, leaseTokenHash: sha256(authority.lease.token) },
            data: { leaseTokenHash: null, leaseUntil: null, ...(permanent ? { status: "BLOCKED", nextAttemptAt: null } :
              { nextAttemptAt: new Date(prepared.result!.nextEligibleAt ?? this.now().getTime() + 60_000) }) } });
          if (permanent) await tx.campaignStepExecution.updateMany({ where: { sendId, status: "SEND_PENDING" }, data: { reason: prepared.result!.code, nextWakeAt: null } });
        });
      }
      return prepared.result!;
    }
    const { send, attempt, credentials, body, lease } = prepared;
    let result: EmailSendResult, preconditionRejected = false;
    try {
      const provider = this.providerFor(send.environment as EmailEnvironment);
      if (provider.capabilities.environment !== send.environment) result = { kind: "NOT_SUBMITTED", code: "MODE_DISABLED" };
      else result = await provider.send({ environment: send.environment as EmailEnvironment, ...credentials, beforeRequest: async operation => {
        if (operation !== "SEND") fail("EMAIL_OPERATION_INVALID", 500, "Unexpected provider operation.");
        try { await this.db.$transaction(async tx => {
          if (authority.kind === "CUSTOMER") await this.session(tx, authority.principal);
          const current = await tx.messageSend.findUniqueOrThrow({ where: { id: send.id } });
          this.verifyLease(current, lease, "SEND");
          await this.executionTx(tx, current, authority.kind === "WORKER");
          const eligible = await checkEmailEligibility(tx, { membershipId: send.membershipId, now: this.now(), liveEnabled: this.options.liveEnabled, purpose: "DISPATCH", sendId: send.id });
          if (!eligible.eligible || current.status !== "SUBMITTING" || current.revision !== attempt.sendRevision ||
            eligible.source.generation !== attempt.connectionGeneration || eligible.connection.credentialVersion !== attempt.credentialVersion ||
            eligible.membership.revision !== attempt.membershipRevision) fail("EMAIL_PRECONDITION_FAILED", 409, "Email eligibility changed before submission.");
          await this.attributeTx(tx, current, eligible);
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
        const automated = await tx.campaignStepExecution.findFirst({ where: { sendId: send.id } });
        const retryAt = result.kind === "REJECTED" && result.retryable && attempt.number < MAX_ATTEMPTS ? new Date(now.getTime() +
          Math.max(automated ? backoff(attempt.number) : 0, result.retryAfterMs ?? 60_000)) : null;
        updated = await tx.messageSend.update({ where: { id: send.id }, data: { status: uncertain ? "UNKNOWN" : current.cancelRequestedAt ? "CANCELLED" :
          result.kind === "NOT_SUBMITTED" ? "PENDING" : "FAILED", nextAttemptAt: retryAt ?? (automated && result.kind === "NOT_SUBMITTED" && !current.cancelRequestedAt ? new Date(now.getTime() + 60_000) : null), revision: { increment: 1 } } });
        if (!uncertain && result.kind === "REJECTED" && (!result.retryable || attempt.number >= MAX_ATTEMPTS))
          await tx.campaignMembership.updateMany({ where: { id: send.membershipId, status: "ACTIVE" }, data: { status: "BLOCKED", revision: { increment: 1 } } });
      }
      // Finalize evidence only after validating the provider identity. A reported acceptance
      // with a conflicting mapping is ambiguous, while any earlier proven mapping stays intact.
      const outcome = result.kind === "ACCEPTED" ? "ACCEPTED" : result.kind === "UNKNOWN" ? "UNKNOWN" : result.kind === "NOT_SUBMITTED" ? "CANCELLED_BEFORE_SUBMIT" : "REJECTED";
      if (!attemptNow.completedAt) await tx.deliveryAttempt.update({ where: { id: attempt.id }, data: { outcome, completedAt: now, errorCode: "code" in result ? result.code : null } });
      await tx.messageSend.updateMany({ where: { id: send.id, leaseTokenHash: sha256(lease.token) }, data: { leaseTokenHash: null, leaseUntil: null } });
      await syncStepFromSendTx(tx, send.id, now);
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
    const synchronized = await syncStepFromSendTx(tx, send.id, this.now());
    if (!synchronized && membership.status === "ACTIVE") {
      const steps = await tx.campaignStep.findMany({ where: { revisionId: membership.revisionId } });
      const accepted = await tx.messageSend.findMany({ where: { membershipId: send.membershipId, status: "ACCEPTED" } });
      if (steps.every(step => accepted.some(item => item.stepId === step.id)))
        await tx.campaignMembership.update({ where: { id: membership.id }, data: { status: "COMPLETED", revision: { increment: 1 } } });
    }
    return updated;
  }
  async reconcile(principal: CustomerPrincipal, sendId: string, value: unknown = {}) {
    return this.reconcileInternal({ kind: "CUSTOMER", principal }, sendId, value);
  }
  async reconcileClaimed(lease: EmailSendLease) {
    try { return await this.reconcileInternal({ kind: "WORKER", lease }, lease.sendId, {}); }
    finally { await this.db.messageSend.updateMany({ where: { id: lease.sendId, leaseTokenHash: sha256(lease.token) },
      data: { leaseTokenHash: null, leaseUntil: null } }); }
  }
  private async reconciliationCandidate(tx: Tx | PrismaClient, send: MessageSend) {
    if (send.providerMessageId) return send.providerMessageId;
    const retained = await tx.emailDeliveryReceipt.findMany({ where: { connectionId: send.connectionId, opaqueSendRef: send.id,
      status: "UNMATCHED", providerMessageId: { not: null } }, take: 21 });
    const candidates = [...new Set(retained.map(r => r.providerMessageId!))];
    return candidates.length === 1 && retained.length <= 20 ? candidates[0] : undefined;
  }
  private async reconcileInternal(authority: SubmissionAuthority, sendId: string, value: unknown) {
    if (authority.kind === "CUSTOMER") await this.auth.assertSession(authority.principal); const input = object(value); fields(input, ["providerMessageId"]);
    const candidateInput = input.providerMessageId === undefined ? undefined : text(input.providerMessageId, 100);
    const send = authority.kind === "CUSTOMER" ? await this.owned(this.db, authority.principal, sendId) : await this.db.messageSend.findUniqueOrThrow({ where: { id: sendId } });
    if (authority.kind === "WORKER") this.verifyLease(send, authority.lease, "RECONCILE");
    if (!send.firstSubmittedAt || send.redactedAt || !send.payloadCiphertext) fail("RECONCILIATION_UNAVAILABLE", 409, "This send has no recoverable submission evidence.");
    const connection = await this.db.emailConnection.findUniqueOrThrow({ where: { id: send.connectionId } });
    const source = await this.db.trackingSource.findUniqueOrThrow({ where: { id: connection.sourceId } });
    const credentials = this.credentials(connection), body = this.vault.decrypt(send.payloadCiphertext, emailPayloadContext(send));
    if (sha256(body) !== send.requestDigest) fail("REQUEST_CHANGED", 409, "The saved email request could not be verified.");
    let candidate = send.providerMessageId ?? candidateInput;
    if (send.providerMessageId && candidateInput && candidateInput !== send.providerMessageId) fail("EMAIL_MAPPING_CONFLICT", 409, "This send already has a different provider identity.");
    if (!candidate) candidate = await this.reconciliationCandidate(this.db, send);
    const unresolved = async (code: string) => {
      const updated = await this.db.$transaction(async tx => {
        if (authority.kind === "CUSTOMER") await this.session(tx, authority.principal);
        const current = authority.kind === "CUSTOMER" ? await this.owned(tx, authority.principal, sendId) : await tx.messageSend.findUniqueOrThrow({ where: { id: sendId } }), now = this.now();
        if (authority.kind === "WORKER") await tx.messageSend.updateMany({ where: { id: sendId, status: "UNKNOWN", leaseTokenHash: sha256(authority.lease.token) },
          data: { reconcileErrorCode: code, nextAttemptAt: new Date(now.getTime() + backoff(current.reconcileAttemptCount)) } });
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
        if (authority.kind === "CUSTOMER") await this.session(tx, authority.principal);
        const current = authority.kind === "CUSTOMER" ? await this.owned(tx, authority.principal, sendId) : await tx.messageSend.findUniqueOrThrow({ where: { id: sendId } }), currentConnection = await tx.emailConnection.findUniqueOrThrow({ where: { id: connection.id } });
        const currentSource = await tx.trackingSource.findUniqueOrThrow({ where: { id: source.id } });
        if (authority.kind === "WORKER") {
          this.verifyLease(current, authority.lease, "RECONCILE");
          await this.executionTx(tx, current, true, false);
          if (current.status !== "UNKNOWN" || current.reconcileAttemptCount >= MAX_ATTEMPTS) fail("EMAIL_RECONCILIATION_BLOCKED", 409, "Automatic readback is exhausted or no longer needed.");
          await tx.messageSend.update({ where: { id: sendId }, data: { reconcileAttemptCount: { increment: 1 }, lastReconciledAt: this.now(),
            nextAttemptAt: new Date(this.now().getTime() + backoff(current.reconcileAttemptCount + 1)) } });
        }
        if (current.redactedAt || !current.payloadCiphertext || currentSource.status === "DISCONNECTED" || currentSource.generation !== source.generation ||
          currentConnection.credentialVersion !== connection.credentialVersion || current.environment === "LIVE" && !this.options.liveEnabled)
          fail("EMAIL_RECONCILIATION_BLOCKED", 409, "Provider read access changed.");
      });
    } }, candidate);
    if (retrieved.kind !== "FOUND") return unresolved(retrieved.kind === "NOT_FOUND" ? "NO_POSITIVE_EVIDENCE" : retrieved.code);
    if (!this.matchesFrozen(send, body, candidate, retrieved.email)) return unresolved("PROVIDER_EVIDENCE_MISMATCH");
    return this.db.$transaction(async tx => {
      if (authority.kind === "CUSTOMER") await this.session(tx, authority.principal);
      const current = authority.kind === "CUSTOMER" ? await this.owned(tx, authority.principal, sendId) : await tx.messageSend.findUniqueOrThrow({ where: { id: sendId } }), now = this.now();
      if (current.redactedAt || current.requestDigest !== send.requestDigest) fail("RECONCILIATION_UNAVAILABLE", 409, "The email was removed while verifying evidence.");
      await tx.deliveryAttempt.updateMany({ where: { sendId, outcome: "IN_FLIGHT", startedAt: { lte: new Date(now.getTime() - 60_000) } },
        data: { outcome: "UNKNOWN", completedAt: now, errorCode: "PROCESS_INTERRUPTED" } });
      const updated = await this.bindAccepted(tx, current, retrieved.email.providerMessageId, new Date(retrieved.email.createdAt));
      // Reconciliation preserves completed attempt outcomes, including UNKNOWN.
      await tx.trackingAudit.create({ data: { ownerId: send.ownerId, environment: send.environment, sourceId: source.id, actorId: authority.kind === "CUSTOMER" ? authority.principal.userId : undefined,
        action: "EMAIL_SEND_RECONCILED", reason: `send:${send.id};request:${send.requestDigest}`, createdAt: now } });
      await settleEmailMembership(tx, send.membershipId, now);
      return { send: summary(updated), outcome: "MATCHED" as const };
    });
  }
  async recoverOnce() {
    const now = this.now(), stale = new Date(now.getTime() - LEASE_MS);
    const hint = await this.db.messageSend.findFirst({ where: { OR: [
      { status: { in: ["PENDING", "FAILED", "BLOCKED"] }, expiresAt: { lte: now }, stepExecution: { is: { status: "SEND_PENDING" } },
        OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
      { leaseUntil: { lte: now } }, { leaseUntil: null, attempts: { some: { outcome: "IN_FLIGHT", startedAt: { lte: stale } } } },
    ] }, orderBy: { updatedAt: "asc" } });
    if (!hint) return null;
    return this.db.$transaction(async tx => {
      const send = await tx.messageSend.findUniqueOrThrow({ where: { id: hint.id } });
      if (send.revision !== hint.revision || send.leaseUntil && send.leaseUntil > this.now()) return null;
      const attempts = await tx.deliveryAttempt.findMany({ where: { sendId: send.id, outcome: "IN_FLIGHT",
        ...(send.leaseUntil ? {} : { startedAt: { lte: stale } }) } });
      const expired = ["PENDING", "FAILED", "BLOCKED"].includes(send.status) && send.expiresAt <= now && !attempts.length;
      if (!send.leaseUntil && !attempts.length && !expired) return null;
      for (const attempt of attempts) await tx.deliveryAttempt.update({ where: { id: attempt.id }, data: { outcome: "UNKNOWN", completedAt: now, errorCode: "PROCESS_INTERRUPTED" } });
      const uncertain = send.status === "SUBMITTING" || attempts.length > 0;
      const status = send.status === "ACCEPTED" ? "ACCEPTED" : uncertain ? "UNKNOWN" : expired ? "EXPIRED" : send.status;
      await tx.messageSend.update({ where: { id: send.id }, data: { status, leaseTokenHash: null, leaseUntil: null, revision: { increment: 1 } } });
      await syncStepFromSendTx(tx, send.id, now); await settleEmailMembership(tx, send.membershipId, now);
      return { sendId: send.id, status, code: uncertain ? "SUBMISSION_OUTCOME_UNKNOWN" : expired ? "SEND_EXPIRED" : "LEASE_RELEASED" };
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
      const suppression = event.type === "email.complained" ? "COMPLAINT" : event.type === "email.suppressed" ? "PROVIDER_SUPPRESSION" :
        event.type === "email.bounced" && event.bounce?.type?.toLowerCase() === "permanent" ? "HARD_BOUNCE" : undefined;
      const send = await tx.messageSend.findFirst({ where: { connectionId: connection.id, providerMessageIdDigest: receipt.providerMessageIdDigest } });
      if (!send) {
        // Verified address-level negative evidence does not require a local message binding.
        // Keep the receipt unmatched: this hold must never manufacture a contact or subject event.
        if (suppression && event.to.length === 1 && receipt.addressDigest) await applyEmailSuppression(tx, {
          ownerId: receipt.ownerId, environment: receipt.environment, addressDigest: receipt.addressDigest,
          category: "*", reason: suppression, sourceId: source.id, receiptId: receipt.id, now,
          requestKey: `email-receipt:${receipt.id}:suppression`, requestDigest: sha256(JSON.stringify([receipt.rawPayloadDigest, suppression])) });
        return complete("UNMATCHED", "PROVIDER_ID_NOT_BOUND");
      }
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
          subjectKind: subject.kind as "CONTACT" | "SALES" | "PURCHASE" | "SUBSCRIPTION", properties: { ...(state ? { deliveryState: state } : {}),
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
