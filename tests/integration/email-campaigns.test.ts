import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createEmailFixture, type EmailFixture } from "../support/email-fixture";
import { emailAddressDigest, emailCredentialContext, emailPayloadContext } from "../../apps/web/src/server/email/emailPolicy";
import type { FunnelDefinition } from "../../apps/web/src/server/funnels/funnelDefinition";

const policyCommand = (f: EmailFixture, contactId: string, action: string, category = "consultation", reason = "Requested by recipient") => ({
  contactId, category, action, reason, requestKey: randomUUID(), provenance: { source: "recorded-form", purpose: category, observedAt: f.now().toISOString() },
});

test("draft CAS and republishing keep an existing subject membership on its immutable revision", async () => {
  const f = await createEmailFixture();
  try {
    const first = await f.enrolled();
    const changed = structuredClone(first.definition); changed.steps[0].subject = "Revised consultation content";
    await f.campaigns.updateDraft(f.principal, first.campaign.id, { draftRevision: 1, definition: changed });
    await assert.rejects(f.campaigns.updateDraft(f.principal, first.campaign.id, { draftRevision: 1, definition: changed }), { code: "DRAFT_CHANGED" });
    await assert.rejects(f.campaigns.publish(f.principal, first.campaign.id, { draftRevision: 1 }), { code: "DRAFT_CHANGED" });
    const second = await f.campaigns.publish(f.principal, first.campaign.id, { draftRevision: 2 });
    assert.equal(second.revision.number, 2); assert.notEqual(second.revision.id, first.revision.id);
    assert.equal((await f.campaigns.publish(f.principal, first.campaign.id, { draftRevision: 2 })).existing, true);
    const reused = await f.campaigns.enrol(f.principal, first.campaign.id, { ...first.command, requestKey: randomUUID(), revisionId: second.revision.id });
    assert.equal(reused.membership.id, first.membership.id);
    assert.equal(reused.membership.revisionId, first.revision.id);
    assert.equal(reused.revisionChoice, "EXISTING_PINNED_REVISION");
    assert.equal(reused.reason.requestedRevisionId, second.revision.id);
    const person = await f.recipient({ contactExternalId: first.contactExternalId });
    const fresh = await f.campaigns.enrol(f.principal, first.campaign.id, { subjectId: person.subject.id, requestKey: randomUUID(), reason: "Separate enquiry" });
    assert.equal(fresh.membership.revisionId, second.revision.id);
    const intent = await f.delivery.createIntent(f.principal, { membershipId: first.membership.id });
    const persisted = await f.db.messageSend.findUniqueOrThrow({ where: { id: intent.send.id } });
    assert.equal(JSON.parse(f.vault.decrypt(persisted.payloadCiphertext!, emailPayloadContext(persisted))).subject, first.definition.steps[0].subject);
    assert.equal((await f.campaigns.get(f.principal, first.campaign.id)).revisions.length, 2);
  } finally { await f.close(); }
});

test("command idempotency and independent manual reasons prevent duplicate membership and premature stopping", async () => {
  const f = await createEmailFixture();
  try {
    const item = await f.enrolled();
    const duplicate = await f.campaigns.enrol(f.principal, item.campaign.id, item.command);
    assert.equal(duplicate.duplicate, true); assert.equal(duplicate.reason.id, item.reason.id);
    await assert.rejects(f.campaigns.enrol(f.principal, item.campaign.id, { ...item.command, reason: "Changed command" }), { code: "IDEMPOTENCY_CONFLICT" });
    const otherJourney = await f.manualJourney(item.subject.id, item.campaign.id);
    const second = await f.campaigns.enrol(f.principal, item.campaign.id, { ...item.command, journeyId: otherJourney.journey.id, requestKey: randomUUID() });
    assert.equal(second.membership.id, item.membership.id);
    const firstStop = await f.campaigns.stop(f.principal, item.membership.id, { reasonId: item.reason.id, reason: "First association ended" });
    assert.equal(firstStop.membership.status, "ACTIVE"); assert.equal(firstStop.reasons.filter(reason => !reason.endedAt).length, 1);
    const pending = await f.delivery.createIntent(f.principal, { membershipId: item.membership.id });
    const lastStop = await f.campaigns.stop(f.principal, item.membership.id, { reasonId: second.reason.id, reason: "Last association ended" });
    assert.equal(lastStop.membership.status, "STOPPED"); assert.ok(lastStop.membership.endedAt);
    assert.equal((await f.delivery.get(f.principal, pending.send.id)).send.status, "CANCELLED");
    await assert.rejects(f.campaigns.enrol(f.principal, item.campaign.id, { ...item.command, requestKey: randomUUID() }), { code: "NEW_CYCLE_REQUIRED" });
    const next = await f.campaigns.enrol(f.principal, item.campaign.id, { ...item.command, requestKey: randomUUID(), newCycle: true });
    assert.equal(next.membership.cycle, 2); assert.notEqual(next.membership.id, item.membership.id);
  } finally { await f.close(); }
});

test("subject scope keeps two enquiries independent; contact scope requires explicit selection and shares one membership", async () => {
  const f = await createEmailFixture();
  try {
    const first = await f.enrolled(), secondPerson = await f.recipient({ contactExternalId: first.contactExternalId });
    assert.equal(first.contact.id, secondPerson.contact.id); assert.notEqual(first.subject.id, secondPerson.subject.id);
    const second = await f.campaigns.enrol(f.principal, first.campaign.id, { subjectId: secondPerson.subject.id, requestKey: randomUUID(), reason: "Second enquiry" });
    assert.notEqual(first.membership.id, second.membership.id);
    await f.campaigns.stop(f.principal, first.membership.id, { reason: "First enquiry resolved" });
    assert.equal((await f.campaigns.membership(f.principal, second.membership.id)).membership.status, "ACTIVE");
    const contactCampaign = await f.publishedCampaign({ setup: first.setup, membershipScope: "CONTACT" });
    await assert.rejects(f.campaigns.enrol(f.principal, contactCampaign.campaign.id, { subjectId: first.subject.id, contactId: first.contact.id,
      requestKey: randomUUID(), reason: "Implicit scope is rejected" }), { code: "INVALID_MEMBERSHIP_SCOPE" });
    const a = await f.campaigns.enrol(f.principal, contactCampaign.campaign.id, { contactId: first.contact.id, journeyId: first.journey!.id, requestKey: randomUUID(), reason: "First journey" });
    const moved = await f.manualJourney(secondPerson.subject.id);
    const b = await f.campaigns.enrol(f.principal, contactCampaign.campaign.id, { contactId: first.contact.id, journeyId: moved.journey.id, requestKey: randomUUID(), reason: "Second journey" });
    assert.equal(a.membership.id, b.membership.id); assert.equal(a.membership.subjectId, null);
    const foreignPerson = await f.recipient();
    await assert.rejects(f.campaigns.enrol(f.principal, contactCampaign.campaign.id, { contactId: foreignPerson.contact.id, journeyId: moved.journey.id,
      requestKey: randomUUID(), reason: "Wrong association" }), { code: "INVALID_JOURNEY_ASSOCIATION" });
  } finally { await f.close(); }
});

test("consent is explicit, audited, idempotent and independent from enrolment and dispatch controls", async () => {
  const f = await createEmailFixture();
  try {
    const person = await f.recipient(), published = await f.publishedCampaign();
    const command = { subjectId: person.subject.id, requestKey: randomUUID(), reason: "Requested follow-up" };
    assert.equal((await f.campaigns.policy(f.principal, person.contact.id, "consultation")).state, "UNKNOWN");
    await assert.rejects(f.campaigns.enrol(f.principal, published.campaign.id, command), { code: "CONSENT_REQUIRED" });
    assert.equal(await f.db.campaignMembership.count(), 0); assert.equal(await f.db.campaignMembershipReason.count(), 0);
    const optIn = policyCommand(f, person.contact.id, "OPT_IN");
    await f.campaigns.updatePolicy(f.principal, optIn); await f.campaigns.updatePolicy(f.principal, optIn);
    assert.equal(await f.db.emailPolicyAudit.count(), 1);
    await assert.rejects(f.campaigns.updatePolicy(f.principal, { ...optIn, action: "OPT_OUT" }), { code: "IDEMPOTENCY_CONFLICT" });
    await assert.rejects(f.campaigns.updatePolicy(f.principal, { ...optIn, requestKey: randomUUID(), provenance: { ...optIn.provenance, observedAt: new Date(f.now().getTime() + 1).toISOString() } }), { code: "INVALID_EMAIL_POLICY" });
    await f.campaigns.controls(f.principal, published.campaign.id, { enrolmentEnabled: false });
    await assert.rejects(f.campaigns.enrol(f.principal, published.campaign.id, command), { code: "ENROLMENT_PAUSED" });
    await f.campaigns.controls(f.principal, published.campaign.id, { enrolmentEnabled: true, dispatchEnabled: false });
    const { membership } = await f.campaigns.enrol(f.principal, published.campaign.id, command);
    await assert.rejects(f.delivery.createIntent(f.principal, { membershipId: membership.id }), { code: "DISPATCH_PAUSED" });
    await f.campaigns.controls(f.principal, published.campaign.id, { dispatchEnabled: true, enrolmentEnabled: false });
    const { send } = await f.delivery.createIntent(f.principal, { membershipId: membership.id });
    assert.equal((await f.delivery.dispatch(f.principal, send.id)).outcome, "ACCEPTED");
  } finally { await f.close(); }
});

test("category opt-out follows canonical address across contacts and provider connections, without merging business identities", async () => {
  const f = await createEmailFixture();
  try {
    const first = await f.enrolled(), secondPerson = await f.recipient({ email: "MAYA@example.test" });
    const second = await f.enrolled({ recipient: secondPerson });
    const otherCategory = await f.enrolled({ recipient: secondPerson, setup: second.setup, category: "product-news" });
    assert.notEqual(first.contact.id, second.contact.id); assert.notEqual(first.setup.connection.id, second.setup.connection.id);
    const a = await f.delivery.createIntent(f.principal, { membershipId: first.membership.id });
    const b = await f.delivery.createIntent(f.principal, { membershipId: second.membership.id });
    await f.campaigns.updatePolicy(f.principal, policyCommand(f, first.contact.id, "OPT_OUT"));
    for (const send of [a.send, b.send]) assert.equal((await f.delivery.get(f.principal, send.id)).send.status, "CANCELLED");
    assert.equal((await f.campaigns.policy(f.principal, second.contact.id, "consultation")).state, "OPTED_OUT");
    assert.equal((await f.campaigns.membership(f.principal, otherCategory.membership.id)).membership.status, "ACTIVE");
    assert.equal((await f.campaigns.policy(f.principal, second.contact.id, "product-news")).eligible, true);
    await f.campaigns.updatePolicy(f.principal, policyCommand(f, second.contact.id, "BLOCK"));
    const reconsent = await f.campaigns.updatePolicy(f.principal, policyCommand(f, first.contact.id, "OPT_IN"));
    assert.equal(reconsent.state, "OPTED_IN"); assert.equal(reconsent.eligible, false); assert.deepEqual(reconsent.holds, [{ category: "consultation", reason: "ADMIN" }]);
    await f.campaigns.updatePolicy(f.principal, policyCommand(f, first.contact.id, "RELEASE", "consultation", "ADMIN"));
    assert.equal((await f.campaigns.policy(f.principal, second.contact.id, "consultation")).eligible, true);
    assert.equal((await f.campaigns.membership(f.principal, first.membership.id)).membership.status, "STOPPED", "Resubscribe never silently reenrols");
    const independent = await f.owner(), recipient = await f.recipient({ principal: independent.principal });
    assert.equal((await f.campaigns.policy(independent.principal, recipient.contact.id, "consultation")).state, "UNKNOWN");
    assert.equal(emailAddressDigest(f.principal.userId, "TEST", " Maya@example.test "), emailAddressDigest(f.principal.userId, "TEST", "maya@example.test"));
    assert.notEqual(emailAddressDigest(f.principal.userId, "TEST", "maya+one@example.test"), emailAddressDigest(f.principal.userId, "TEST", "maya@example.test"));
    assert.notEqual(emailAddressDigest(f.principal.userId, "TEST", "m.aya@example.test"), emailAddressDigest(f.principal.userId, "TEST", "maya@example.test"));
    assert.notEqual(emailAddressDigest(f.principal.userId, "TEST", "maya@example.test"), emailAddressDigest(f.principal.userId, "LIVE", "maya@example.test"));
  } finally { await f.close(); }
});

test("sender readiness is tied to current source generation, credentials and a recent authenticated provider check", async () => {
  const f = await createEmailFixture();
  try {
    const setup = await f.readyConnection();
    const stored = await f.db.emailConnection.findUniqueOrThrow({ where: { id: setup.connection.id } });
    assert.doesNotMatch(JSON.stringify(await f.connections.get(f.principal, stored.id)), /fixture_|whsec_|credentialCiphertext|expectedWebhookUrlDigest/);
    assert.doesNotMatch(stored.credentialCiphertext, /fixture_|whsec_/);
    assert.equal(JSON.parse(f.vault.decrypt(stored.credentialCiphertext, emailCredentialContext(stored))).apiKey, setup.apiKey);
    assert.throws(() => f.vault.decrypt(stored.credentialCiphertext, emailCredentialContext({ ...stored, id: randomUUID() })), { code: "CREDENTIAL_UNAVAILABLE" });
    const campaign = await f.campaigns.create(f.principal, { name: "Draft", environment: "TEST", definition: f.definition(setup.sender.id) });
    f.setNow(new Date(f.now().getTime() + 900_001));
    await assert.rejects(f.campaigns.publish(f.principal, campaign.id, { draftRevision: 1 }), { code: "EMAIL_READINESS_REQUIRED" });
    await f.connections.checkSender(f.principal, setup.sender.id);
    await f.connections.update(f.principal, stored.id, { apiKey: setup.apiKey });
    await assert.rejects(f.campaigns.publish(f.principal, campaign.id, { draftRevision: 1 }), { code: "EMAIL_READINESS_REQUIRED" });
    const checked = await f.connections.checkSender(f.principal, setup.sender.id);
    assert.equal((checked.readiness as { generation: number }).generation, setup.connection.generation + 1);
    await f.campaigns.publish(f.principal, campaign.id, { draftRevision: 1 });
    const rotated = await f.connections.update(f.principal, stored.id, { rotateIngress: true });
    assert.notEqual(rotated.webhookUrl, setup.webhookUrl);
    const mismatch = await f.connections.checkSender(f.principal, setup.sender.id);
    assert.equal(mismatch.status, "UNAVAILABLE");
    setup.account.webhookUrl = rotated.webhookUrl!;
    assert.equal((await f.connections.checkSender(f.principal, setup.sender.id)).status, "VERIFIED");
    const requestCount = f.requests.length;
    await f.connections.update(f.principal, stored.id, { status: "PAUSED" });
    await assert.rejects(f.connections.checkSender(f.principal, setup.sender.id), { code: "EMAIL_CONNECTION_UNAVAILABLE" });
    assert.equal(f.requests.length, requestCount);
  } finally { await f.close(); }
});

test("tenant and environment ownership applies to connections, senders, campaigns and manual journey associations", async () => {
  const f = await createEmailFixture();
  try {
    const item = await f.enrolled(), other = await f.owner();
    assert.deepEqual(await f.connections.list(other.principal, "TEST"), []);
    assert.deepEqual(await f.campaigns.list(other.principal, "TEST"), []);
    for (const action of [() => f.connections.get(other.principal, item.setup.connection.id),
      () => f.connections.update(other.principal, item.setup.connection.id, { status: "PAUSED" }),
      () => f.connections.checkSender(other.principal, item.setup.sender.id),
      () => f.campaigns.get(other.principal, item.campaign.id),
      () => f.campaigns.membership(other.principal, item.membership.id),
      () => f.campaigns.stop(other.principal, item.membership.id, { reason: "Foreign command" }),
      () => f.campaigns.policy(other.principal, item.contact.id, "consultation")]) await assert.rejects(action, { code: "NOT_FOUND" });
    const foreign = await f.campaigns.create(other.principal, { name: "Bad sender", environment: "TEST", definition: item.definition });
    await assert.rejects(f.campaigns.publish(other.principal, foreign.id, { draftRevision: 1 }), { code: "EMAIL_SENDER_UNAVAILABLE" });
    const crossEnvironment = await f.campaigns.create(f.principal, { name: "Wrong environment", environment: "LIVE", definition: item.definition });
    await assert.rejects(f.campaigns.publish(f.principal, crossEnvironment.id, { draftRevision: 1 }), { code: "EMAIL_SENDER_UNAVAILABLE" });
  } finally { await f.close(); }
});

test("campaign-stage links are immutable attribution and do not authorize automatic sends", async () => {
  const f = await createEmailFixture();
  try {
    const person = await f.recipient(), campaign = await f.campaigns.create(f.principal, { name: "Paid search", environment: "TEST", category: "PAID" });
    const linked = await f.manualJourney(person.subject.id, campaign.id);
    const links = await f.db.stageCampaignLink.findMany({ where: { versionId: linked.publication.version.id } });
    assert.equal(links.length, 1); assert.equal(links[0].campaignId, campaign.id);
    assert.equal(await f.db.campaignMembership.count(), 0); assert.equal(await f.db.messageSend.count(), 0);
    const outbox = await f.db.funnelActionOutbox.findFirstOrThrow({ where: { journeyId: linked.journey.id } });
    assert.equal(outbox.effectEligibility, "TRACKING_ONLY"); assert.deepEqual((outbox.payload as { actions: unknown[] }).actions, []);
    await assert.rejects(f.campaigns.publish(f.principal, campaign.id, { draftRevision: 1 }), { code: "CAMPAIGN_ATTRIBUTION_ONLY" });
    const def: FunnelDefinition = { schemaVersion: 1, stages: [{ id: "lead", name: "Lead", goal: false, terminal: "NONE" }], entryStages: ["lead"], routes: [],
      campaignLinks: [{ id: "paid", stageId: "lead", campaignId: campaign.id, purpose: "ATTRIBUTION" }] };
    const other = await f.owner(), foreign = await f.funnels.create(other.principal, { name: "Foreign link", environment: "TEST", subjectKind: "SALES", definition: def });
    await assert.rejects(f.funnels.publish(other.principal, foreign.id, { draftRevision: 1 }), { code: "FUNNEL_CAMPAIGN_UNAVAILABLE" });
    const live = await f.funnels.create(f.principal, { name: "Live link", environment: "LIVE", subjectKind: "SALES", definition: def });
    await assert.rejects(f.funnels.publish(f.principal, live.id, { draftRevision: 1 }), { code: "FUNNEL_CAMPAIGN_UNAVAILABLE" });
    await f.campaigns.controls(f.principal, campaign.id, { status: "ARCHIVED" });
    await f.funnels.updateDraft(f.principal, linked.funnel.id, { draftRevision: 1, definition: def });
    await assert.rejects(f.funnels.publish(f.principal, linked.funnel.id, { draftRevision: 2 }), { code: "FUNNEL_CAMPAIGN_UNAVAILABLE" });
    assert.equal(await f.db.stageCampaignLink.count({ where: { versionId: linked.publication.version.id } }), 1);
  } finally { await f.close(); }
});

test("stopping an uncertain send keeps its scope occupied and contact deletion erases content without bypassing uncertainty", async () => {
  const f = await createEmailFixture();
  try {
    const item = await f.enrolled();
    const { send } = await f.delivery.createIntent(f.principal, { membershipId: item.membership.id });
    f.transport.onSend = () => { throw new Error("Fixture response lost after submission"); };
    assert.equal((await f.delivery.dispatch(f.principal, send.id)).outcome, "UNKNOWN");
    const stopped = await f.campaigns.stop(f.principal, item.membership.id, { reason: "Customer cancelled" });
    assert.equal(stopped.membership.status, "STOPPED"); assert.equal(stopped.membership.endedAt, null);
    await assert.rejects(f.campaigns.enrol(f.principal, item.campaign.id, { ...item.command, requestKey: randomUUID(), newCycle: true }), { code: "MEMBERSHIP_ALREADY_OPEN" });
    await assert.rejects(f.campaigns.enrol(f.principal, item.campaign.id, { ...item.command, requestKey: randomUUID() }), { code: "MEMBERSHIP_INACTIVE" });
    await f.tracking.deleteContact(f.principal, item.contact.id);
    const erased = await f.db.messageSend.findUniqueOrThrow({ where: { id: send.id } });
    assert.equal(erased.status, "UNKNOWN"); assert.equal(erased.payloadCiphertext, null); assert.ok(erased.redactedAt); assert.ok(erased.cancelRequestedAt);
    const membership = await f.db.campaignMembership.findUniqueOrThrow({ where: { id: item.membership.id } });
    assert.equal(membership.endedAt, null);
    assert.equal((await f.db.funnelContact.findUniqueOrThrow({ where: { id: item.contact.id } })).email, null);
    assert.equal((await f.db.campaignMembershipReason.findUniqueOrThrow({ where: { id: item.reason.id } })).note, null);
    const sameAddress = await f.recipient();
    const policy = await f.campaigns.policy(f.principal, sameAddress.contact.id, "consultation");
    assert.equal(policy.eligible, false); assert.ok(policy.holds.some(hold => hold.reason === "CONTACT_DELETED"));
    assert.equal(f.requests.filter(request => request.method === "POST" && request.url.endsWith("/emails")).length, 1);
  } finally { await f.close(); }
});

test("timed sequences publish but manual sending cannot bypass explicit cadence start or its wait", async () => {
  const f = await createEmailFixture();
  try {
    const setup = await f.readyConnection(), definition = f.definition(setup.sender.id);
    definition.steps[0].wait = { kind: "DURATION", seconds: 60 };
    definition.steps.push({ ...definition.steps[0], id: "second", wait: { kind: "IMMEDIATE" } });
    const published = await f.publishedCampaign({ setup, definition }), item = await f.enrolled({ published, journey: false });
    await assert.rejects(f.delivery.createIntent(f.principal, { membershipId: item.membership.id }), { code: "EMAIL_STEP_UNAVAILABLE" });
    assert.equal((await f.campaigns.membership(f.principal, item.membership.id)).cadenceStarted, false);
    await f.campaigns.start(f.principal, item.membership.id, { requestKey: randomUUID(), reason: "Start the reviewed sequence" });
    await assert.rejects(f.delivery.createIntent(f.principal, { membershipId: item.membership.id }), { code: "STEP_WAITING" });
    assert.equal((await f.campaigns.membership(f.principal, item.membership.id)).steps[0].dueAt!.toISOString(), "2026-10-19T10:01:00.000Z");
    await assert.rejects(f.campaigns.updateDraft(f.principal, item.campaign.id, { draftRevision: 1,
      definition: { ...definition, steps: [...definition.steps, { ...definition.steps[0] }] } }), { code: "INVALID_EMAIL_DEFINITION" });
  } finally { await f.close(); }
});
