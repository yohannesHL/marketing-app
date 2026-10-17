import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import { createEmailFixture, EMAIL_FIXTURE_ORIGIN, type EmailFixture } from "../support/email-fixture";
import { FunnelReportingService } from "../../apps/web/src/server/funnels/funnelReportingService";
import { createFunnelReportingApi } from "../../apps/web/src/server/funnels/funnelReportingApi";
import { createFunnelApi } from "../../apps/web/src/server/funnels/funnelApi";
import type { FunnelDefinition } from "../../apps/web/src/server/funnels/funnelDefinition";

const secret = "reporting-fixture-signing-secret";
const at = (seconds: number) => new Date(Date.parse("2026-10-19T10:00:00Z") + seconds * 1000);
const request = (from = 0, to = 100) => ({ from: at(from).toISOString(), to: at(to).toISOString() });
async function source(f: EmailFixture) {
  return (await f.tracking.createSource(f.principal, { name: "Reporting API", provider: "API", environment: "TEST", externalAccountId: randomUUID(),
    credentials: { signingSecret: secret }, config: { allowedEvents: ["enquiry.accepted", "custom.booked", "deal.won", "order.paid", "custom.observed"],
      propertyKeys: ["amount", "currency", "campaign", "utm_source", "utm_medium", "utm_campaign", "utm_content", "unreported"] } })).source;
}
async function event(f: EmailFixture, sourceId: string, id: string, type = "enquiry.accepted", properties: Record<string, unknown> = {}, options: { subjectKind?: string; contact?: string } = {}) {
  const kind = options.subjectKind ?? "SALES", body = JSON.stringify({ schemaVersion: 1, type, occurredAt: f.now().toISOString(), subjectKind: kind,
    resource: { kind: kind === "PURCHASE" ? "ORDER" : "ENQUIRY", id }, contactIdentity: { kind: "CRM_CONTACT", id: options.contact ?? "same-person" },
    contact: { email: "private-person@example.test", name: "Private recipient" }, properties });
  const time = String(f.now().getTime() / 1000), key = randomUUID();
  const result = await f.tracking.collectApi(sourceId, new Headers({ "x-launchpad-id": key, "x-launchpad-timestamp": time,
    "x-launchpad-signature": createHmac("sha256", secret).update(`${time}.${key}.${body}`).digest("hex") }), body);
  while (await f.tracking.processOnce()) { /* Real matcher. */ }
  while (await f.funnels.processOnce()) { /* Real versioned evaluator. */ }
  return f.db.trackingEvent.findUniqueOrThrow({ where: { id: result.receipts[0].id } });
}
function definition(sourceId: string): FunnelDefinition {
  const route = (id: string, from: string | null, type: string, to: string) => ({ id, from, trigger: { kind: "EVENT" as const, sourceId, type }, branches: [{ id: `${id}-yes`, to }], fallback: { kind: "WAIT" as const } });
  return { schemaVersion: 1, stages: [{ id: "lead", name: "Enquiry", goal: false, terminal: "NONE" }, { id: "booked", name: "Meeting", goal: true, terminal: "NONE" },
    { id: "won", name: "Recorded sale", goal: true, terminal: "SUCCESS" }], entryStages: ["lead", "booked"], routes: [route("entry", null, "enquiry.accepted", "lead"), route("meeting", "lead", "custom.booked", "booked"), route("won", "booked", "deal.won", "won")] };
}
async function publish(f: EmailFixture, def: FunnelDefinition) {
  const funnel = await f.funnels.create(f.principal, { name: "Results fixture", environment: "TEST", subjectKind: "SALES", definition: def });
  const published = await f.funnels.publish(f.principal, funnel.id, { draftRevision: 1 }); return { funnel, version: published.version };
}
const service = (f: EmailFixture) => new FunnelReportingService(f.db, f.auth, f.now);

test("version cohort counts cycles, goals, occupancy and manual corrections without treating cancellation as another visit", async () => {
  const f = await createEmailFixture();
  try {
    const s = await source(f), { funnel, version } = await publish(f, definition(s.id));
    f.setNow(at(1)); const a = await event(f, s.id, "a");
    f.setNow(at(2)); const b = await event(f, s.id, "b");
    f.setNow(at(3)); await event(f, s.id, "a", "custom.booked");
    f.setNow(at(4)); await f.funnels.move(f.principal, funnel.id, { subjectId: a.subjectId, stageId: "booked", reason: "Confirm same meeting stage", commandKey: randomUUID() });
    f.setNow(at(5)); await event(f, s.id, "a", "deal.won", { amount: "0.30", currency: "GBP" });
    const jb = await f.db.funnelJourney.findFirstOrThrow({ where: { subjectId: b.subjectId! } });
    f.setNow(at(6)); await f.funnels.cancelJourney(f.principal, funnel.id, jb.id, { reason: "Previous cycle closed" });
    f.setNow(at(7)); await f.funnels.move(f.principal, funnel.id, { subjectId: b.subjectId, stageId: "booked", reason: "Explicit repeat cycle", newCycle: true, commandKey: randomUUID() });
    f.setNow(at(8)); await event(f, s.id, "boundary");
    f.setNow(at(9)); const report = await service(f).report(f.principal, funnel.id, { ...request(1, 8), versionId: version.id });
    assert.deepEqual([report.totals.journeys, report.totals.distinctSubjects, report.totals.repeatCycles], [3, 2, 1]);
    assert.deepEqual([report.totals.active, report.totals.succeeded, report.totals.cancelled, report.totals.goalJourneys], [1, 1, 1, 2]);
    assert.equal(report.totals.goalRate.value, 2 / 3); assert.equal(report.totals.manualEntryJourneys, 1);
    const lead = report.stages[0], booked = report.stages[1];
    assert.deepEqual([lead.everReachedJourneys, lead.currentJourneys, lead.activeJourneys, lead.knownExitJourneys, lead.visits], [2, 1, 0, 1, 2]);
    assert.deepEqual([booked.everReachedJourneys, booked.currentJourneys, booked.visits, booked.manualVisits], [2, 1, 3, 2]);
    assert.equal(booked.completedResidence.meanMs, 1000); assert.equal(booked.openResidence.meanMs, 2000);
    assert.equal(report.coverage.cancellationCommands, 1); assert.equal(report.coverage.manualTransitions, 2);
    assert.deepEqual(report.branches.find(row => row.ruleId === "meeting")?.progression, { numerator: 1, denominator: 2, value: 0.5 });
    assert.equal(report.money.currencies[0].recordedWonValue.amount, "0.3"); assert.equal(report.money.currencies[0].grossPaid.facts, 0);
    const earlierCohort = await service(f).report(f.principal, funnel.id, request(1, 3));
    assert.equal(earlierCohort.totals.journeys, 2); assert.equal(earlierCohort.totals.goalJourneys, 1); assert.equal(earlierCohort.money.includedFacts, 1, "later outcome included through current asOf");
    const next = structuredClone(definition(s.id)); next.stages[0].name = "Renamed entry";
    await f.funnels.updateDraft(f.principal, funnel.id, { draftRevision: 1, definition: next }); await f.funnels.publish(f.principal, funnel.id, { draftRevision: 2 });
    f.setNow(at(10)); await event(f, s.id, "new-version"); f.setNow(at(11));
    const latest = await service(f).report(f.principal, funnel.id, request(0, 11)); assert.equal(latest.totals.journeys, 1); assert.equal(latest.stages[0].name, "Renamed entry");
    const old = await service(f).report(f.principal, funnel.id, { ...request(1, 8), versionId: version.id }); assert.equal(old.stages[0].name, "Enquiry"); assert.equal(old.totals.journeys, 3);
  } finally { await f.close(); }
});

test("aggregate HTTP API validates current owner/session/version and is a private read-only snapshot", async () => {
  const f = await createEmailFixture();
  try {
    const person = await f.recipient(), created = await f.manualJourney(person.subject.id); f.setNow(at(2));
    const reporting = service(f), api = createFunnelReportingApi(f.auth, reporting);
    const url = `${EMAIL_FIXTURE_ORIGIN}/api/funnels/${created.funnel.id}/reports?from=${at(0).toISOString()}&to=${at(2).toISOString()}`;
    const before = await f.db.$queryRawUnsafe("SELECT total_changes() AS changes"), requestsBefore = f.requests.length;
    const response = await api(new Request(url, { headers: { cookie: f.cookie } })); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json(); assert.equal(body.totals.journeys, 1); assert.doesNotMatch(JSON.stringify(body), /maya@example|private-person|contactId|subjectId|credential|Ciphertext|leaseToken|commandDigest/);
    assert.deepEqual(await f.db.$queryRawUnsafe("SELECT total_changes() AS changes"), before); assert.equal(f.requests.length, requestsBefore); assert.equal(await f.db.messageSend.count(), 0);
    assert.equal((await api(new Request(url))).status, 401);
    const other = await f.owner(); assert.equal((await api(new Request(url, { headers: { cookie: other.cookie } }))).status, 404);
    const foreign = await f.manualJourney((await f.recipient({ principal: other.principal })).subject.id, undefined, other.principal);
    assert.equal((await api(new Request(`${url}&versionId=${foreign.publication.version.id}`, { headers: { cookie: f.cookie } }))).status, 404);
    for (const suffix of ["&asOf=2026-10-19T10:00:01Z", "&ownerId=someone", "&from=2026-10-19T10:00:00Z"])
      assert.equal((await api(new Request(url + suffix, { headers: { cookie: f.cookie } }))).status, 400);
    await assert.rejects(reporting.report(f.principal, created.funnel.id, request(2, 1)), { code: "INVALID_REPORT_RANGE" });
    await assert.rejects(reporting.report(f.principal, created.funnel.id, request(0, 3)), { code: "INVALID_REPORT_RANGE" });
    await assert.rejects(reporting.report(f.principal, created.funnel.id, { from: "2026-02-30T00:00:00Z", to: at(1).toISOString() }), { code: "INVALID_REPORT_RANGE" });
    assert.equal((await api(new Request(url, { method: "POST", headers: { cookie: f.cookie, origin: "https://foreign.test" } }))).status, 403);
    await f.db.customerSession.delete({ where: { id: f.principal.sessionId } });
    assert.equal((await api(new Request(url, { headers: { cookie: f.cookie } }))).status, 401);
  } finally { await f.close(); }
});

test("money sums exact distinct retained facts by currency and does not turn legacy unvalued facts into known zero", async () => {
  const f = await createEmailFixture();
  try {
    const person = await f.recipient(), item = await f.manualJourney(person.subject.id);
    const base = { ownerId: f.principal.userId, environment: "TEST", subjectId: person.subject.id, createdAt: at(0), occurredAt: at(1) };
    // Retained/imported ledger fixtures exercise the report boundary, including values current ingress rejects.
    for (const [key, type, amount, currency, authority] of [
      ["paid-a", "order.paid", "0.1", "GBP", "PROVIDER_VERIFIED"], ["paid-b", "order.paid", "0.200000", "GBP", "SERVER_ASSERTED"],
      ["paid-c", "order.paid", "1.234567", "USD", "PROVIDER_VERIFIED"], ["refund", "refund.succeeded", "0.1", "GBP", "PROVIDER_VERIFIED"],
      ["won", "deal.won", "999999999999999.999999", "GBP", "USER_RECORDED"], ["legacy-unvalued", "order.paid", null, "GBP", "USER_RECORDED"],
      ["legacy-currency", "order.paid", "500", null, "USER_RECORDED"], ["known-zero", "order.paid", "0", "EUR", "SERVER_ASSERTED"],
    ] as const) await f.db.trackingFact.create({ data: { ...base, key, type, authority, attributes: { amount, currency } } });
    await f.db.trackingFact.create({ data: { ...base, key: "before-window", type: "order.paid", authority: "PROVIDER_VERIFIED", occurredAt: at(-1), attributes: { amount: "25", currency: "GBP" } } });
    f.setNow(at(2)); await f.funnels.cancelJourney(f.principal, item.funnel.id, item.journey.id, { reason: "Finish first cycle" });
    f.setNow(at(3)); await f.funnels.move(f.principal, item.funnel.id, { subjectId: person.subject.id, stageId: "lead", reason: "Explicit cycle", newCycle: true, commandKey: randomUUID() });
    f.setNow(at(4)); const report = await service(f).report(f.principal, item.funnel.id, request(0, 4));
    assert.equal(report.totals.journeys, 2); assert.equal(report.totals.distinctSubjects, 1);
    const gbp = report.money.currencies.find(c => c.currency === "GBP")!, usd = report.money.currencies.find(c => c.currency === "USD")!;
    assert.equal(gbp.grossPaid.amount, "0.3"); assert.equal(gbp.successfulRefunds.amount, "0.1"); assert.equal(gbp.netObservedCash, "0.2");
    assert.equal(gbp.recordedWonValue.amount, "999999999999999.999999"); assert.equal(usd.grossPaid.amount, "1.234567");
    assert.equal(gbp.grossPaid.valuedFacts, 2); assert.equal(gbp.grossPaid.unvaluedFacts, 1); assert.equal(gbp.grossPaid.facts, 3);
    assert.equal(report.money.currencies.find(c => c.currency === "EUR")?.grossPaid.valuedFacts, 1);
    assert.equal(report.money.includedFacts, 8); assert.equal(report.money.unvaluedFacts, 2); assert.equal(report.money.missingOrInvalidCurrencyFacts, 1); assert.equal(report.money.excludedBeforeWindowFacts, 1);
    assert.equal(report.money.pipelineValue.available, false);
    await assert.rejects(new FunnelReportingService(f.db, f.auth, f.now, { facts: 1 }).report(f.principal, item.funnel.id, request(0, 4)), { code: "REPORT_LIMIT_EXCEEDED" });
  } finally { await f.close(); }
});

test("observed attribution distinguishes known, partial, unknown and multiple tags without reading private envelope fields", async () => {
  const f = await createEmailFixture();
  try {
    const s = await source(f), item = await publish(f, definition(s.id));
    f.setNow(at(1)); const a = await event(f, s.id, "a", "enquiry.accepted", { campaign: "launch", utm_source: "newsletter", utm_medium: "email", utm_campaign: "autumn", utm_content: "OPAQUE_CORRELATION_SECRET", unreported: "PRIVATE_ATTRIBUTE" });
    f.setNow(at(2)); await event(f, s.id, "a", "custom.observed", { campaign: "another" });
    f.setNow(at(3)); await event(f, s.id, "b", "enquiry.accepted", { campaign: "launch" });
    f.setNow(at(4)); const c = await event(f, s.id, "c", "enquiry.accepted", {}, { contact: "separate-person" });
    f.setNow(at(5)); await f.tracking.replay(f.principal, s.id, a.id); while (await f.tracking.processOnce()) { /* Existing event reprocessed, no new facts. */ }
    while (await f.funnels.processOnce()) { /* Replay cannot add new entries. */ }
    f.setNow(at(6)); await f.tracking.deleteContact(f.principal, c.contactId!);
    f.setNow(at(7)); const result = await service(f).report(f.principal, item.funnel.id, request(0, 7));
    assert.deepEqual([result.attribution.taggedSubjects, result.attribution.partialSubjects, result.attribution.unknownSubjects, result.attribution.multiReferenceSubjects], [2, 1, 1, 1]);
    assert.equal(result.attribution.references.length, 3); assert.equal(result.attribution.redactedEvents, 1);
    assert.equal(result.coverage.matchedEvidenceByProcessingMode.REPLAY, 1); assert.equal(result.attribution.revenueCredit, "NONE");
    assert.equal(result.attribution.nonAdditive, true); assert.doesNotMatch(JSON.stringify(result), /OPAQUE_CORRELATION_SECRET|PRIVATE_ATTRIBUTE|private-person@example|Private recipient/);
    await assert.rejects(new FunnelReportingService(f.db, f.auth, f.now, { events: 1 }).report(f.principal, item.funnel.id, request(0, 7)), { code: "REPORT_LIMIT_EXCEEDED" });
  } finally { await f.close(); }
});

test("shared campaign results use the actual pinned revision and only reasons captured on each send", async () => {
  const f = await createEmailFixture();
  try {
    const enrolled = await f.enrolled({ membershipScope: "CONTACT" });
    const otherJourney = await f.manualJourney(enrolled.subject.id, enrolled.campaign.id);
    const updated = structuredClone(enrolled.definition); updated.steps[0].subject = "A newer revision";
    await f.campaigns.updateDraft(f.principal, enrolled.campaign.id, { draftRevision: 1, definition: updated });
    const secondRevision = await f.campaigns.publish(f.principal, enrolled.campaign.id, { draftRevision: 2 });
    await f.campaigns.enrol(f.principal, enrolled.campaign.id, { ...enrolled.command, journeyId: otherJourney.journey.id, revisionId: secondRevision.revision.id, requestKey: randomUUID() });
    const intent = await f.delivery.createIntent(f.principal, { membershipId: enrolled.membership.id });
    const laterJourney = await f.manualJourney(enrolled.subject.id, enrolled.campaign.id);
    await f.campaigns.enrol(f.principal, enrolled.campaign.id, { ...enrolled.command, journeyId: laterJourney.journey.id, requestKey: randomUUID() });
    f.setNow(at(2)); const requestsBefore = f.requests.length;
    const first = await service(f).report(f.principal, enrolled.funnel!.id, request(0, 2)), second = await service(f).report(f.principal, otherJourney.funnel.id, request(0, 2));
    for (const report of [first, second]) {
      assert.equal(report.campaigns.results.length, 1); const group = report.campaigns.results[0];
      assert.equal(group.revisionId, enrolled.revision.id); assert.equal(group.revisionNumber, 1);
      assert.deepEqual([group.memberships.unique, group.sends.unique, group.sends.sharedAcrossJourneys, group.sends.sharedOutsideCohort], [1, 1, 1, 1]);
      assert.equal(group.sends.statusCounts[intent.send.status], 1); assert.equal(report.campaigns.nonAdditiveAcrossReports, true);
    }
    const later = await service(f).report(f.principal, laterJourney.funnel.id, request(0, 2));
    assert.equal(later.campaigns.uniqueMemberships, 1); assert.equal(later.campaigns.uniqueAttributedSends, 0, "later reason cannot claim earlier send");
    assert.equal(later.campaigns.configuredLinks.length, 1); assert.equal(f.requests.length, requestsBefore);
    await assert.rejects(new FunnelReportingService(f.db, f.auth, f.now, { campaignRows: 1 }).report(f.principal, enrolled.funnel!.id, request(0, 2)), { code: "REPORT_LIMIT_EXCEEDED" });
  } finally { await f.close(); }
});

test("limits fail the complete snapshot and projection excludes large unused payload properties", async () => {
  const f = await createEmailFixture();
  try {
    const s = await source(f), item = await publish(f, definition(s.id));
    f.setNow(at(1)); await event(f, s.id, "a", "enquiry.accepted", { unreported: "x".repeat(1000) });
    f.setNow(at(2)); await event(f, s.id, "b", "enquiry.accepted", { unreported: "y".repeat(1000) });
    f.setNow(at(3));
    const projected = await new FunnelReportingService(f.db, f.auth, f.now, { projectedBytes: 2400 }).report(f.principal, item.funnel.id, request(0, 3));
    assert.equal(projected.totals.journeys, 2, "unused payload bytes never enter projected data budget");
    for (const limits of [{ journeys: 1 }, { transitions: 1 }, { projectedBytes: 1500 }])
      await assert.rejects(new FunnelReportingService(f.db, f.auth, f.now, limits).report(f.principal, item.funnel.id, request(0, 3)), { code: "REPORT_LIMIT_EXCEEDED" });
    const empty = await service(f).report(f.principal, item.funnel.id, request(-2, 0));
    assert.equal(empty.totals.journeys, 0); assert.equal(empty.totals.goalRate.value, null); assert.equal(empty.stages[0].completedResidence.meanMs, null); assert.deepEqual(empty.money.currencies, []);
    assert.equal(empty.coverage.completeWithinLimits, true);
  } finally { await f.close(); }
});

test("board pagination keeps full filtered totals and safe contact summaries without mixing versions or owners", async () => {
  const f = await createEmailFixture();
  try {
    const first = await f.recipient(), item = await f.manualJourney(first.subject.id);
    for (let index = 0; index < 50; index++) {
      const person = await f.recipient(); await f.funnels.move(f.principal, item.funnel.id, { subjectId: person.subject.id, stageId: "lead", reason: "Create board fixture", commandKey: randomUUID() });
    }
    f.setNow(at(2)); const query = { ...request(0, 2), versionId: item.publication.version.id };
    const page = await f.funnels.journeys(f.principal, item.funnel.id, undefined, query);
    assert.equal(page.total, 51); assert.equal(page.journeys.length, 50); assert.ok(page.nextCursor); assert.equal(page.journeys[0].subject.contact?.email, "maya@example.test");
    const next = await f.funnels.journeys(f.principal, item.funnel.id, page.nextCursor!, query);
    assert.equal(next.total, 51); assert.equal(next.journeys.length, 1); assert.equal(next.nextCursor, null);
    assert.equal(new Set([...page.journeys, ...next.journeys].map(j => j.id)).size, 51);
    await assert.rejects(f.funnels.journeys(f.principal, item.funnel.id, "unknown-cursor", query), { code: "NOT_FOUND" });
    await assert.rejects(f.funnels.journeys(f.principal, item.funnel.id, page.nextCursor!, { ...query, ...request(1, 2) }), { code: "NOT_FOUND" });
    const other = await f.owner(); await assert.rejects(f.funnels.journeys(other.principal, item.funnel.id, undefined, query), { code: "NOT_FOUND" });
    const draft = item.funnel.draft as unknown as FunnelDefinition; draft.stages[0].name = "Next-version label";
    await f.funnels.updateDraft(f.principal, item.funnel.id, { draftRevision: 1, definition: draft }); const version2 = await f.funnels.publish(f.principal, item.funnel.id, { draftRevision: 2 });
    assert.equal((await f.funnels.journeys(f.principal, item.funnel.id, undefined, { ...query, versionId: version2.version.id })).total, 0);
    await assert.rejects(f.funnels.journeys(f.principal, item.funnel.id, page.nextCursor!, { ...query, versionId: version2.version.id }), { code: "NOT_FOUND" });
    await f.tracking.deleteContact(f.principal, first.contact.id);
    const api = createFunnelApi(f.auth, f.funnels), response = await api(new Request(`${EMAIL_FIXTURE_ORIGIN}/api/funnels/${item.funnel.id}/journeys?versionId=${query.versionId}&from=${query.from}&to=${query.to}`, { headers: { cookie: f.cookie } }));
    assert.equal(response.status, 200); const board = await response.json(); assert.equal(board.total, 51); assert.equal(board.journeys.find((j: { id: string }) => j.id === item.journey.id).subject.contact, null);
    assert.equal((await service(f).report(f.principal, item.funnel.id, query)).totals.journeys, 51);
  } finally { await f.close(); }
});
