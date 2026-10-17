import type { Prisma, PrismaClient, CampaignMembership } from "../../generated/prisma/client";
import type { CustomerAuth, CustomerPrincipal } from "../auth/customerAuth";
import { fail } from "../security/errors";
import { fields, object, sha256, text, timestamp } from "../funnels/trackingValidation";
import { assertCampaignExecutionSupported, assertCampaignSourcesTx, emailEnvironment, emailRevision, subscriptionCategory, validateCampaignDefinition } from "./campaignDefinition";
import { ensureFirstStepTx } from "./campaignStepService";
import { simulateCampaign } from "./campaignSimulation";
import { applyEmailOptOut, applyEmailSuppression, checkEmailEligibility, emailAddressDigest, emailJson, recordEmailPolicyAudit, stopEmailMembership } from "./emailPolicy";

type Tx = Prisma.TransactionClient;
const membershipDto = (m: CampaignMembership) => ({ id: m.id, campaignId: m.campaignId, revisionId: m.revisionId,
  scopeKind: m.scopeKind, subjectId: m.subjectId, contactId: m.contactId, cycle: m.cycle, status: m.status, revision: m.revision,
  startedAt: m.startedAt, endedAt: m.endedAt, stopReason: m.stopReason });

export class MarketingCampaignService {
  constructor(private readonly db: PrismaClient, private readonly auth: CustomerAuth, private readonly now = () => new Date(), private readonly liveEnabled = false) {}
  private async session(tx: Tx, p: CustomerPrincipal) {
    if (!await tx.customerSession.findFirst({ where: { id: p.sessionId, userId: p.userId, expiresAt: { gt: this.now() } } }))
      fail("UNAUTHENTICATED", 401, "Sign in to continue.");
  }
  private async owned(tx: Tx | PrismaClient, p: CustomerPrincipal, id: string) {
    const campaign = await tx.marketingCampaign.findFirst({ where: { id, ownerId: p.userId } });
    if (!campaign) fail("NOT_FOUND", 404, "Marketing campaign not found."); return campaign;
  }
  async list(p: CustomerPrincipal, environment: string) {
    await this.auth.assertSession(p); emailEnvironment(environment);
    return this.db.marketingCampaign.findMany({ where: { ownerId: p.userId, environment }, orderBy: { createdAt: "desc" }, take: 100 });
  }
  async get(p: CustomerPrincipal, id: string) {
    await this.auth.assertSession(p); const campaign = await this.owned(this.db, p, id);
    const revisions = await this.db.campaignRevision.findMany({ where: { campaignId: id }, orderBy: { number: "desc" }, take: 30, include: { steps: { orderBy: { position: "asc" } } } });
    return { ...campaign, revisions, capability: campaign.category === "EMAIL" ? "OWNED_EMAIL_SEQUENCE" : "ATTRIBUTION_ONLY",
      existingMemberships: "PINNED_REVISION", automaticStageActions: "EXPLICIT_ENABLEMENT", manualCadence: "EXPLICIT_START" };
  }
  async create(p: CustomerPrincipal, value: unknown) {
    await this.auth.assertSession(p); const input = object(value); fields(input, ["name", "environment", "category", "membershipScope", "definition"]);
    const name = text(input.name, 120), environment = emailEnvironment(input.environment), category = input.category ?? "EMAIL", membershipScope = input.membershipScope ?? "SUBJECT";
    if (!["EMAIL", "PAID", "SOCIAL", "EXTERNAL"].includes(String(category)) || !["SUBJECT", "CONTACT"].includes(String(membershipScope)))
      fail("INVALID_CAMPAIGN_INPUT", 400, "Choose a campaign category and membership scope.");
    const definition = category === "EMAIL" ? validateCampaignDefinition(input.definition) : {};
    if (category !== "EMAIL" && input.definition !== undefined) fail("CAMPAIGN_ATTRIBUTION_ONLY", 400, "This category is an attribution identity; it has no email execution definition.");
    return this.db.$transaction(async tx => {
      await this.session(tx, p);
      if (await tx.marketingCampaign.count({ where: { ownerId: p.userId, environment } }) >= 100)
        fail("MARKETING_CAMPAIGN_LIMIT", 409, "Use up to 100 marketing campaigns per environment.");
      return tx.marketingCampaign.create({ data: { ownerId: p.userId, environment, name, category: String(category), membershipScope: String(membershipScope), draft: emailJson(definition), createdAt: this.now() } });
    });
  }
  async updateDraft(p: CustomerPrincipal, id: string, value: unknown) {
    await this.auth.assertSession(p); const input = object(value); fields(input, ["draftRevision", "name", "definition"]);
    const draftRevision = emailRevision(input.draftRevision), name = input.name === undefined ? undefined : text(input.name, 120);
    return this.db.$transaction(async tx => {
      await this.session(tx, p); const campaign = await this.owned(tx, p, id);
      if (campaign.category !== "EMAIL" && input.definition !== undefined) fail("CAMPAIGN_ATTRIBUTION_ONLY", 400, "This campaign supports attribution only.");
      const draft = campaign.category === "EMAIL" ? emailJson(validateCampaignDefinition(input.definition)) : {};
      if (!(await tx.marketingCampaign.updateMany({ where: { id, draftRevision }, data: { name, draft, draftRevision: { increment: 1 } } })).count)
        fail("DRAFT_CHANGED", 409, "This draft changed. Reload before saving.");
      return tx.marketingCampaign.findUniqueOrThrow({ where: { id } });
    });
  }
  async publish(p: CustomerPrincipal, id: string, value: unknown) {
    await this.auth.assertSession(p); const input = object(value); fields(input, ["draftRevision"]); const reviewed = emailRevision(input.draftRevision);
    return this.db.$transaction(async tx => {
      await this.session(tx, p); const campaign = await this.owned(tx, p, id);
      if (campaign.category !== "EMAIL") fail("CAMPAIGN_ATTRIBUTION_ONLY", 409, "This campaign has no supported email delivery capability.");
      if (campaign.draftRevision !== reviewed) fail("DRAFT_CHANGED", 409, "Review the current draft before publishing.");
      const definition = validateCampaignDefinition(campaign.draft); assertCampaignExecutionSupported(definition);
      await assertCampaignSourcesTx(tx, campaign, definition);
      const sender = await tx.emailSender.findFirst({ where: { id: definition.senderId, ownerId: p.userId, environment: campaign.environment } });
      if (!sender) fail("EMAIL_SENDER_UNAVAILABLE", 409, "Choose an owned sender in the same environment.");
      const connection = await tx.emailConnection.findUniqueOrThrow({ where: { id: sender.connectionId } });
      const source = await tx.trackingSource.findUniqueOrThrow({ where: { id: connection.sourceId } });
      const readiness = sender.readiness as { ready?: boolean; generation?: number; credentialVersion?: number; checkedAt?: string };
      const age = this.now().getTime() - Date.parse(readiness.checkedAt ?? "");
      if (source.status !== "ACTIVE" || sender.status !== "VERIFIED" || !readiness.ready || readiness.generation !== source.generation ||
        readiness.credentialVersion !== connection.credentialVersion || !Number.isFinite(age) || age < 0 || age > 900_000)
        fail("EMAIL_READINESS_REQUIRED", 409, "Check the sender and webhook before publishing this email campaign.");
      const digest = sha256(JSON.stringify(definition)), prior = await tx.campaignRevision.findFirst({ where: { campaignId: id }, orderBy: { number: "desc" } });
      if (prior?.digest === digest) return { revision: prior, existing: true };
      const revision = await tx.campaignRevision.create({ data: { ownerId: p.userId, environment: campaign.environment, campaignId: id,
        number: (prior?.number ?? 0) + 1, definition: emailJson(definition), digest, senderId: sender.id, subscriptionCategory: definition.subscriptionCategory,
        timeZone: definition.timeZone, sendWindow: emailJson(definition.sendWindow), publishedAt: this.now(), createdAt: this.now() } });
      for (const [position, step] of definition.steps.entries()) await tx.campaignStep.create({ data: { ownerId: p.userId, environment: campaign.environment,
        revisionId: revision.id, key: step.id, position, subject: step.subject, html: step.html, text: step.text, wait: emailJson(step.wait),
        expiresAfterDueSeconds: step.expiresAfterDueSeconds, createdAt: this.now() } });
      await tx.marketingCampaign.update({ where: { id }, data: { publishedRevisionId: revision.id, status: "ACTIVE" } });
      return { revision, existing: false, existingMemberships: "PINNED_REVISION" };
    });
  }
  async controls(p: CustomerPrincipal, id: string, value: unknown) {
    await this.auth.assertSession(p); const input = object(value); fields(input, ["enrolmentEnabled", "dispatchEnabled", "status"]);
    for (const key of ["enrolmentEnabled", "dispatchEnabled"]) if (input[key] !== undefined && typeof input[key] !== "boolean") fail("INVALID_CAMPAIGN_INPUT", 400, "Use explicit control booleans.");
    if (input.status !== undefined && !["ACTIVE", "ARCHIVED"].includes(String(input.status))) fail("INVALID_CAMPAIGN_INPUT", 400, "Choose ACTIVE or ARCHIVED.");
    return this.db.$transaction(async tx => {
      await this.session(tx, p); const campaign = await this.owned(tx, p, id);
      if ((input.enrolmentEnabled || input.dispatchEnabled || input.status === "ACTIVE") && (campaign.category !== "EMAIL" || !campaign.publishedRevisionId))
        fail("CAMPAIGN_UNPUBLISHED", 409, "Publish an email campaign before enabling delivery controls.");
      return tx.marketingCampaign.update({ where: { id }, data: { enrolmentEnabled: input.enrolmentEnabled as boolean | undefined,
        dispatchEnabled: input.dispatchEnabled as boolean | undefined, status: input.status as string | undefined } });
    });
  }
  async simulate(p: CustomerPrincipal, id: string, value: unknown) {
    await this.auth.assertSession(p); const campaign = await this.owned(this.db, p, id), input = object(value);
    if (campaign.category !== "EMAIL") fail("CAMPAIGN_ATTRIBUTION_ONLY", 409, "This campaign has no email sequence to preview.");
    return simulateCampaign(validateCampaignDefinition(input.definition ?? campaign.draft), input);
  }
  async enrol(p: CustomerPrincipal, campaignId: string, value: unknown) {
    await this.auth.assertSession(p); const input = object(value); fields(input, ["subjectId", "contactId", "journeyId", "revisionId", "requestKey", "reason", "newCycle"]);
    const requestKey = text(input.requestKey, 128), note = text(input.reason, 500), requestedRevision = input.revisionId === undefined ? undefined : text(input.revisionId, 128);
    const subjectId = input.subjectId === undefined ? undefined : text(input.subjectId, 128), contactId = input.contactId === undefined ? undefined : text(input.contactId, 128),
      journeyId = input.journeyId === undefined ? undefined : text(input.journeyId, 128);
    if (input.newCycle !== undefined && typeof input.newCycle !== "boolean") fail("INVALID_CAMPAIGN_INPUT", 400, "Choose whether to start a new cycle.");
    const requestDigest = sha256(JSON.stringify([campaignId, requestedRevision, subjectId, contactId, journeyId, note, input.newCycle ?? false]));
    return this.db.$transaction(async tx => {
      await this.session(tx, p); const campaign = await this.owned(tx, p, campaignId), owned = { ownerId: p.userId, environment: campaign.environment };
      const priorCommand = await tx.campaignMembershipReason.findFirst({ where: { ...owned, requestKey } });
      if (priorCommand) {
        if (priorCommand.requestDigest !== requestDigest) fail("IDEMPOTENCY_CONFLICT", 409, "This enrolment key was used for a different request.");
        return { membership: membershipDto(await tx.campaignMembership.findUniqueOrThrow({ where: { id: priorCommand.membershipId } })), reason: priorCommand, existing: true, duplicate: true };
      }
      if (campaign.category !== "EMAIL" || !campaign.publishedRevisionId) fail("CAMPAIGN_UNPUBLISHED", 409, "Publish a supported email campaign first.");
      const revisionId = requestedRevision ?? campaign.publishedRevisionId;
      if (!await tx.campaignRevision.findFirst({ where: { id: revisionId, campaignId, ...owned } })) fail("NOT_FOUND", 404, "Campaign revision not found.");
      const subject = subjectId ? await tx.funnelSubject.findFirst({ where: { id: subjectId, ...owned } }) : null;
      if (campaign.membershipScope === "SUBJECT" && (!subject?.contactId || contactId && contactId !== subject.contactId) ||
        campaign.membershipScope === "CONTACT" && (subjectId !== undefined || !contactId))
        fail("INVALID_MEMBERSHIP_SCOPE", 400, "SUBJECT campaigns need an identified business subject; CONTACT campaigns need only an explicit contact.");
      const recipientId = campaign.membershipScope === "SUBJECT" ? subject!.contactId! : contactId!;
      const contact = await tx.funnelContact.findFirst({ where: { id: recipientId, ...owned, deletedAt: null } });
      if (!contact?.email) fail("RECIPIENT_UNAVAILABLE", 409, "The owned recipient needs a current email address.");
      if (journeyId) {
        const journey = await tx.funnelJourney.findFirst({ where: { id: journeyId, ...owned } });
        const journeySubject = journey && await tx.funnelSubject.findUnique({ where: { id: journey.subjectId } });
        if (!journey || campaign.membershipScope === "SUBJECT" && journey.subjectId !== subjectId || journeySubject?.contactId !== contact.id)
          fail("INVALID_JOURNEY_ASSOCIATION", 400, "Associate a journey for this same recipient and membership scope.");
      }
      const scopeKey = `${campaign.membershipScope}:${campaign.membershipScope === "SUBJECT" ? subjectId : recipientId}`;
      const previous = await tx.campaignMembership.findFirst({ where: { campaignId, scopeKey }, orderBy: { cycle: "desc" } });
      if (previous && !previous.endedAt && input.newCycle) fail("MEMBERSHIP_ALREADY_OPEN", 409, "Resolve or stop the existing membership before a new cycle.");
      if (previous?.endedAt && !input.newCycle) fail("NEW_CYCLE_REQUIRED", 409, "Explicitly request a new cycle after a completed or stopped membership.");
      if (previous && !previous.endedAt && previous.status !== "ACTIVE") fail("MEMBERSHIP_INACTIVE", 409, "The existing membership is blocked or stopped; unresolved acceptance cannot be bypassed.");
      const existing = previous && !previous.endedAt ? previous : null, addressDigest = emailAddressDigest(p.userId, campaign.environment, contact.email);
      if (!existing && await tx.campaignMembership.count({ where: { ...owned, addressDigest, endedAt: null } }) >= 200)
        fail("RECIPIENT_MEMBERSHIP_LIMIT", 409, "This delivery address already has 200 open memberships.");
      const membership = existing ?? await tx.campaignMembership.create({ data: { ...owned, campaignId, revisionId, scopeKind: campaign.membershipScope, scopeKey,
        subjectId: campaign.membershipScope === "SUBJECT" ? subjectId : null, contactId: recipientId, addressDigest, cycle: (previous?.cycle ?? 0) + 1,
        startedAt: this.now(), createdAt: this.now() } });
      if (await tx.campaignMembershipReason.count({ where: { membershipId: membership.id, endedAt: null } }) >= 100)
        fail("MEMBERSHIP_REASON_LIMIT", 409, "This membership already has 100 active associations.");
      const reason = await tx.campaignMembershipReason.create({ data: { ...owned, membershipId: membership.id, campaignId, requestedRevisionId: revisionId,
        kind: "MANUAL", requestKey, requestDigest, journeyId, actorId: p.userId, note, createdAt: this.now() } });
      const eligible = await checkEmailEligibility(tx, { membershipId: membership.id, now: this.now(), liveEnabled: this.liveEnabled, purpose: "ENROL" });
      if (!eligible.eligible) fail(eligible.code, 409, "Enrolment is blocked. Check recipient consent, campaign controls and current sender readiness.");
      return { membership: membershipDto(membership), reason, existing: !!existing, duplicate: false,
        revisionChoice: membership.revisionId === revisionId ? "REQUESTED_REVISION" : "EXISTING_PINNED_REVISION" };
    });
  }
  async memberships(p: CustomerPrincipal, campaignId: string, cursor?: string) {
    await this.auth.assertSession(p); await this.owned(this.db, p, campaignId);
    const rows = await this.db.campaignMembership.findMany({ where: { campaignId, ownerId: p.userId, ...(cursor ? { id: { gt: text(cursor) } } : {}) }, orderBy: { id: "asc" }, take: 50 });
    return { memberships: rows.map(membershipDto), nextCursor: rows.length === 50 ? rows.at(-1)!.id : null };
  }
  async start(p: CustomerPrincipal, id: string, value: unknown) {
    await this.auth.assertSession(p); const input = object(value); fields(input, ["requestKey", "reason"]);
    const requestKey = text(input.requestKey, 128), reason = text(input.reason, 500);
    const requestDigest = sha256(JSON.stringify(["START_CAMPAIGN", id, reason]));
    return this.db.$transaction(async tx => {
      await this.session(tx, p);
      const membership = await tx.campaignMembership.findFirst({ where: { id, ownerId: p.userId } });
      if (!membership) fail("NOT_FOUND", 404, "Membership not found.");
      const prior = await tx.campaignStepExecution.findFirst({ where: { ownerId: p.userId, environment: membership.environment, authorizationRequestKey: requestKey } });
      if (prior) {
        if (prior.membershipId !== id || prior.authorizationRequestDigest !== requestDigest) fail("IDEMPOTENCY_CONFLICT", 409, "This start key was used for another request.");
        return { membershipId: id, executionId: prior.id, status: prior.status, existing: true, reason: prior.reason };
      }
      const eligibility = await checkEmailEligibility(tx, { membershipId: id, now: this.now(), liveEnabled: this.liveEnabled, purpose: "START" });
      if (!eligibility.eligible) fail(eligibility.code, 409, "Starting this sequence is blocked by its current membership, recipient or connection policy.");
      const execution = await ensureFirstStepTx(tx, id, { kind: "MANUAL", requestKey, requestDigest, actorId: p.userId, reason }, this.now());
      return { membershipId: id, executionId: execution.id, status: execution.status, existing: false, reason: execution.reason };
    });
  }
  async membership(p: CustomerPrincipal, id: string) {
    await this.auth.assertSession(p); const m = await this.db.campaignMembership.findFirst({ where: { id, ownerId: p.userId } });
    if (!m) fail("NOT_FOUND", 404, "Membership not found.");
    const reasons = await this.db.campaignMembershipReason.findMany({ where: { membershipId: id }, orderBy: { createdAt: "asc" }, take: 200 });
    const sends = await this.db.messageSend.findMany({ where: { membershipId: id }, orderBy: { dueAt: "asc" }, take: 100,
      select: { id: true, stepId: true, status: true, deliveryState: true, dueAt: true, acceptedAt: true, cancelRequestedAt: true } });
    const steps = await this.db.campaignStepExecution.findMany({ where: { membershipId: id }, orderBy: [{ sequenceAnchorAt: "asc" }, { createdAt: "asc" }], take: 100 });
    return { membership: membershipDto(m), reasons, sends, steps, cadenceStarted: steps.length > 0 };
  }
  async stop(p: CustomerPrincipal, id: string, value: unknown) {
    await this.auth.assertSession(p); const input = object(value); fields(input, ["reasonId", "reason"]); const reason = text(input.reason, 500);
    await this.db.$transaction(async tx => {
      await this.session(tx, p); const membership = await tx.campaignMembership.findFirst({ where: { id, ownerId: p.userId } });
      if (!membership) fail("NOT_FOUND", 404, "Membership not found.");
      if (input.reasonId !== undefined) {
        const association = await tx.campaignMembershipReason.findFirst({ where: { id: text(input.reasonId), membershipId: id } });
        if (!association) fail("NOT_FOUND", 404, "Membership association not found.");
        if (!association.endedAt) await tx.campaignMembershipReason.update({ where: { id: association.id }, data: { endedAt: this.now(), endReason: reason } });
        if (await tx.campaignMembershipReason.count({ where: { membershipId: id, endedAt: null } })) return;
      }
      await stopEmailMembership(tx, id, reason, this.now());
    });
    return this.membership(p, id);
  }
  private async contact(tx: Tx | PrismaClient, p: CustomerPrincipal, contactId: string) {
    const contact = await tx.funnelContact.findFirst({ where: { id: contactId, ownerId: p.userId, deletedAt: null } });
    if (!contact?.email) fail("NOT_FOUND", 404, "Recipient not found.");
    return { ownerId: p.userId, environment: contact.environment, addressDigest: emailAddressDigest(p.userId, contact.environment, contact.email) };
  }
  async policy(p: CustomerPrincipal, contactId: string, category: string) {
    await this.auth.assertSession(p); subscriptionCategory(category); const identity = await this.contact(this.db, p, text(contactId));
    const subscription = await this.db.emailSubscription.findFirst({ where: { ...identity, category } });
    const suppressions = await this.db.emailSuppression.findMany({ where: { ...identity, category: { in: ["*", category] }, active: true } });
    return { state: subscription?.state ?? "UNKNOWN", category, changedAt: subscription?.changedAt ?? null,
      eligible: subscription?.state === "OPTED_IN" && !suppressions.length, holds: suppressions.map(s => ({ category: s.category, reason: s.reason })) };
  }
  async updatePolicy(p: CustomerPrincipal, value: unknown) {
    await this.auth.assertSession(p); const input = object(value); fields(input, ["contactId", "category", "action", "reason", "requestKey", "provenance"]);
    const contactId = text(input.contactId), category = subscriptionCategory(input.category), action = text(input.action), requestKey = text(input.requestKey, 128), reason = text(input.reason, 500);
    if (!["OPT_IN", "OPT_OUT", "BLOCK", "RELEASE"].includes(action)) fail("INVALID_EMAIL_POLICY", 400, "Choose an explicit subscription or suppression operation.");
    const evidence = object(input.provenance); fields(evidence, ["source", "purpose", "observedAt", "note"]);
    const provenance = { source: text(evidence.source, 100), purpose: text(evidence.purpose, 200), observedAt: timestamp(evidence.observedAt),
      ...(evidence.note === undefined ? {} : { note: text(evidence.note, 500) }) };
    if (new Date(provenance.observedAt) > this.now()) fail("INVALID_EMAIL_POLICY", 400, "Consent evidence cannot be from the future.");
    const requestDigest = sha256(JSON.stringify([contactId, category, action, reason, provenance]));
    await this.db.$transaction(async tx => {
      await this.session(tx, p); const identity = await this.contact(tx, p, contactId), command = { ...identity, category, requestKey, requestDigest,
        actorId: p.userId, provenance: { ...provenance, reason }, now: this.now() };
      if (action === "OPT_OUT") { await applyEmailOptOut(tx, command); return; }
      if (action === "BLOCK") { await applyEmailSuppression(tx, { ...command, reason: "ADMIN" }); return; }
      if (!await recordEmailPolicyAudit(tx, command, action, reason, provenance)) return;
      if (action === "RELEASE") {
        if (!["ADMIN", "HARD_BOUNCE", "COMPLAINT", "PROVIDER_SUPPRESSION"].includes(reason))
          fail("INVALID_EMAIL_POLICY", 400, "Release a named hold; OPT_IN is the separate audited resubscribe operation.");
        await tx.emailSuppression.updateMany({ where: { ...identity, reason, category: { in: [category, "*"] }, active: true }, data: { active: false, revokedAt: this.now() } });
      } else {
        const current = await tx.emailSubscription.findFirst({ where: { ...identity, category } });
        if (current) await tx.emailSubscription.update({ where: { id: current.id }, data: { state: "OPTED_IN", changedAt: this.now(), provenance: emailJson(provenance), revision: { increment: 1 } } });
        else await tx.emailSubscription.create({ data: { ...identity, category, state: "OPTED_IN", changedAt: this.now(), provenance: emailJson(provenance), createdAt: this.now() } });
        await tx.emailSuppression.updateMany({ where: { ...identity, category, reason: "OPT_OUT", active: true }, data: { active: false, revokedAt: this.now() } });
      }
    });
    return this.policy(p, contactId, category);
  }
}
