import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac, randomUUID } from "node:crypto";
import { createEmailFixture, type EmailFixture } from "../support/email-fixture";
import { createTrackingApi } from "../../apps/web/src/server/funnels/trackingApi";
import { createEmailApi } from "../../apps/web/src/server/email/emailApi";
import { AutomationRunner } from "../../apps/web/src/server/email/automationRunner";
import { FunnelReportingService } from "../../apps/web/src/server/funnels/funnelReportingService";
import type { FunnelDefinition } from "../../apps/web/src/server/funnels/funnelDefinition";

const origin = "https://launchpad.test", site = "https://business.example.test", secret = "release-proof-signing-secret";
const tick = (f: EmailFixture, ms = 1000) => f.setNow(new Date(f.now().getTime() + ms));
async function jsonResponse(response: Response, status = 202): Promise<any> {
  assert.equal(response.status, status, await response.clone().text()); return response.json();
}
function trackingHttp(f: EmailFixture, path: string, body: unknown, headers: HeadersInit = {}) {
  return createTrackingApi(f.auth, f.tracking)(new Request(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) }, body: JSON.stringify(body) }));
}
async function apiEvent(f: EmailFixture, sourceId: string, body: unknown, requestId = randomUUID()) {
  const raw = JSON.stringify(body), time = String(Math.floor(f.now().getTime() / 1000));
  return jsonResponse(await trackingHttp(f, `/api/tracking/ingest/${sourceId}/events`, body, {
    "x-launchpad-id": requestId, "x-launchpad-timestamp": time,
    "x-launchpad-signature": createHmac("sha256", secret).update(`${time}.${requestId}.${raw}`).digest("hex"),
  }));
}
async function consent(f: EmailFixture, contactId: string, category: string) {
  await jsonResponse(await createEmailApi(f.auth, f.connections, f.campaigns, f.delivery)(new Request(`${origin}/api/email/policy`, { method: "POST",
    headers: { "content-type": "application/json", origin, cookie: f.cookie }, body: JSON.stringify({ contactId, category, action: "OPT_IN", reason: "Fixture recipient explicitly requested this category", requestKey: randomUUID(),
      provenance: { source: "fixture-consent-form", purpose: category, observedAt: f.now().toISOString() } }) })), 200);
}
async function drain(f: EmailFixture, runner?: AutomationRunner) {
  for (let n = 0; n < 100; n++) if (!await (runner ? runner.processOnce() : f.tracking.processOnce())) return;
  throw new Error("Release fixture did not reach a stable persisted state");
}
const runnerFor = (f: EmailFixture) => new AutomationRunner(f.db, { tracking: f.tracking, funnels: f.funnels, connections: f.connections, delivery: f.delivery }, { now: f.now });
const route = (id: string, from: string | null, sourceId: string, type: string, to: string) => ({ id, from, trigger: { kind: "EVENT" as const, sourceId, type }, branches: [], fallback: { kind: "MOVE" as const, to } });
async function publishFunnel(f: EmailFixture, subjectKind: "SALES" | "PURCHASE", definition: FunnelDefinition) {
  const funnel = await f.funnels.create(f.principal, { name: `${subjectKind} release proof`, environment: "TEST", subjectKind, definition });
  const { version } = await f.funnels.publish(f.principal, funnel.id, { draftRevision: 1 });
  await f.funnels.controls(f.principal, funnel.id, { automationEnrolmentEnabled: true, automationDispatchEnabled: true });
  return { funnel, version };
}
async function apiSource(f: EmailFixture) {
  return (await f.tracking.createSource(f.principal, { name: "Business server", provider: "API", environment: "TEST", externalAccountId: randomUUID(), credentials: { signingSecret: secret },
    config: { propertyKeys: ["amount", "currency", "campaign", "utm_source", "utm_medium", "utm_campaign"] } })).source;
}
function salesEvent(f: EmailFixture, id: string, type = "enquiry.accepted", extra: Record<string, unknown> = {}) {
  return { schemaVersion: 1, type, occurredAt: f.now().toISOString(), resource: { kind: "ENQUIRY", id }, subjectKind: "SALES", contactIdentity: { kind: "CRM_CONTACT", id: "person-1" }, contact: { email: "maya@example.test" }, ...extra };
}

test("release proof: tagged native form, stable API handoff, two enquiries, nurture, verified booking cancels only its reminder, recorded sale", async () => {
  const f = await createEmailFixture(); try {
    const from = f.now().toISOString();
    const native = (await f.tracking.createSource(f.principal, { name: "Website", provider: "NATIVE", environment: "TEST", externalAccountId: randomUUID(), config: { allowedOrigins: [site] } })).source;
    const api = await apiSource(f);
    const calendly = await f.tracking.createSource(f.principal, { name: "Bookings", provider: "CALENDLY", environment: "TEST", externalAccountId: "https://api.calendly.com/users/host-a", config: { correlationField: "utm_content" }, credentials: { signingSecret: secret, apiToken: "fixture-only" } });
    const setup = await f.readyConnection(), draft = f.definition(setup.sender.id);
    draft.steps.push({ id: "reminder", subject: "Book your consultation", text: "Choose a meeting time when you are ready.", wait: { kind: "DURATION", seconds: 120 }, expiresAfterDueSeconds: 3600 });
    const campaign = await f.publishedCampaign({ setup, definition: draft });
    const { funnel, version } = await publishFunnel(f, "SALES", { schemaVersion: 1,
      stages: [{ id: "enquiry", name: "Enquiry", goal: false, terminal: "NONE" }, { id: "meeting", name: "Meeting", goal: false, terminal: "NONE" }, { id: "won", name: "Won", goal: true, terminal: "SUCCESS" }], entryStages: ["enquiry"],
      routes: [route("entry", null, api.id, "enquiry.accepted", "enquiry"), route("book", "enquiry", calendly.source.id, "booking.confirmed", "meeting"), route("win", "meeting", api.id, "deal.won", "won")],
      campaignLinks: [{ id: "nurture-attribution", stageId: "enquiry", campaignId: campaign.campaign.id, purpose: "ATTRIBUTION" }],
      stageActions: [{ id: "nurture", stageId: "enquiry", kind: "EMAIL_ENROLL", campaignId: campaign.campaign.id, revisionId: campaign.revision.id, delaySeconds: 0, expiresAfterDueSeconds: 3600, stopOnStageExit: true, stopOnGoal: true }] });
    tick(f);
    const visitor = await jsonResponse(await trackingHttp(f, `/api/tracking/ingest/${native.id}/visitor`, {}, { origin: site }), 201);
    const page = await jsonResponse(await trackingHttp(f, `/api/tracking/ingest/${native.id}/collect`, { schemaVersion: 1, eventId: "tagged-visit", visitorToken: visitor.visitorToken, type: "page.viewed",
      properties: { path: "/consultation", campaign: "spring-consultation", utm_source: "newsletter", utm_medium: "email", utm_campaign: "spring" } }, { origin: site }));
    await drain(f);
    const accepted = await jsonResponse(await trackingHttp(f, `/api/tracking/ingest/${native.id}/form`, { schemaVersion: 1, eventId: "form-a", visitorToken: visitor.visitorToken, name: "Maya", email: "maya@example.test" }, { origin: site }));
    await drain(f);
    const form = await f.db.trackingEvent.findUniqueOrThrow({ where: { id: accepted.receipts[0].id } });
    assert.ok(form.contactId && form.subjectId); await consent(f, form.contactId, "consultation");
    const visit = await f.db.trackingEvent.findUniqueOrThrow({ where: { id: page.receipts[0].id } });
    assert.equal(visit.subjectId, form.subjectId); assert.equal(visit.processingMode, "REPLAY");
    tick(f);
    const first = await apiEvent(f, api.id, salesEvent(f, "crm-a", "enquiry.accepted", { references: [{ sourceId: native.id, kind: "ENQUIRY", id: "form-a" }] }));
    tick(f); const second = await apiEvent(f, api.id, salesEvent(f, "crm-b"));
    const runner = runnerFor(f); await drain(f, runner);
    const a = await f.db.trackingEvent.findUniqueOrThrow({ where: { id: first.receipts[0].id } }), b = await f.db.trackingEvent.findUniqueOrThrow({ where: { id: second.receipts[0].id } });
    assert.equal(a.subjectId, form.subjectId); assert.notEqual(a.subjectId, b.subjectId); assert.equal(a.contactId, b.contactId);
    assert.equal(await f.db.funnelContact.count(), 1); assert.equal(await f.db.campaignMembership.count(), 2);
    assert.equal(await f.db.messageSend.count({ where: { status: "ACCEPTED", deliveryState: "UNKNOWN" } }), 2);
    const memberships = await f.db.campaignMembership.findMany();
    const memberA = memberships.find(m => m.subjectId === a.subjectId)!, memberB = memberships.find(m => m.subjectId === b.subjectId)!;
    const reminder = await f.db.campaignStep.findFirstOrThrow({ where: { revisionId: campaign.revision.id, key: "reminder" } });
    const reminderB = await f.db.campaignStepExecution.findFirstOrThrow({ where: { membershipId: memberB.id, stepId: reminder.id } });
    assert.equal(reminderB.status, "WAITING");
    const correlation = await f.tracking.createCorrelation(f.principal, calendly.source.id, { subjectId: a.subjectId }); tick(f);
    const eventUri = "https://api.calendly.com/scheduled_events/meeting-a", booking = { event: "invitee.created", created_at: f.now().toISOString(), payload: {
      uri: `${eventUri}/invitees/maya-a`, event: eventUri, status: "active", created_at: f.now().toISOString(), updated_at: f.now().toISOString(), email: "maya@example.test", name: "Maya", rescheduled: false, old_invitee: null, new_invitee: null,
      tracking: { utm_content: correlation.token }, scheduled_event: { uri: eventUri, event_memberships: [{ user: "https://api.calendly.com/users/host-a" }] } } };
    const raw = JSON.stringify(booking), t = String(Math.floor(f.now().getTime() / 1000));
    const bookingReceipt = await jsonResponse(await trackingHttp(f, `/api/tracking/hooks/${calendly.ingressToken}`, booking, { "Calendly-Webhook-Signature": `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}` }));
    await drain(f, runner);
    assert.equal((await f.db.campaignMembership.findUniqueOrThrow({ where: { id: memberA.id } })).status, "STOPPED");
    assert.equal((await f.db.campaignStepExecution.findFirstOrThrow({ where: { membershipId: memberA.id, stepId: reminder.id } })).status, "CANCELLED");
    const stillB = await f.db.campaignStepExecution.findUniqueOrThrow({ where: { id: reminderB.id } });
    assert.equal(stillB.status, "WAITING"); assert.equal(stillB.dueAt?.getTime(), reminderB.dueAt?.getTime());
    assert.equal((await f.db.trackingEvent.findUniqueOrThrow({ where: { id: bookingReceipt.receipts[0].id } })).subjectId, a.subjectId);
    tick(f); await apiEvent(f, api.id, salesEvent(f, "crm-a", "deal.won", { properties: { amount: "2500.00", currency: "GBP" } })); await drain(f, runner);
    tick(f, 120_000); await drain(f, runner);
    assert.equal(await f.db.messageSend.count({ where: { membershipId: memberA.id, status: "ACCEPTED" } }), 1);
    assert.equal(await f.db.messageSend.count({ where: { membershipId: memberB.id, status: "ACCEPTED" } }), 2);
    assert.equal(f.requests.filter(request => request.method === "POST").length, 3);
    const report = await new FunnelReportingService(f.db, f.auth, f.now).report(f.principal, funnel.id, { versionId: version.id, from, to: f.now().toISOString() });
    assert.equal(report.totals.journeys, 2); assert.equal(report.totals.goalJourneys, 1); assert.equal(report.totals.goalRate.value, .5);
    assert.equal(report.stages.find(s => s.stageId === "enquiry")!.everReachedJourneys, 2);
    assert.equal(report.stages.find(s => s.stageId === "enquiry")!.currentJourneys, 1);
    const gbp = report.money.currencies.find(c => c.currency === "GBP")!;
    assert.equal(gbp.recordedWonValue.amount, "2500"); assert.equal(gbp.recordedWonValue.authorityCounts.SERVER_ASSERTED, 1); assert.equal(gbp.grossPaid.facts, 0);
    assert.ok(report.attribution.references.some(ref => ref.values.utm_campaign === "spring"));
    assert.equal(report.attribution.revenueCredit, "NONE"); assert.ok(!JSON.stringify(report).includes(correlation.token));
    const journeys = await f.db.funnelJourney.findMany({ where: { funnelId: funnel.id } });
    const history = await f.funnels.history(f.principal, funnel.id, journeys.find(j => j.subjectId === a.subjectId)!.id);
    assert.equal(history.transitions.length, 3);
    for (const send of await f.db.messageSend.findMany()) { assert.ok(send.providerMessageId); assert.equal(await f.db.deliveryAttempt.count({ where: { sendId: send.id, outcome: "ACCEPTED" } }), 1); }
    for (const sensitive of [secret, setup.apiKey, setup.secret, correlation.token]) assert.ok(!JSON.stringify({ report, history }).includes(sensitive));
  } finally { await f.close(); }
});

async function shopHook(f: EmailFixture, token: string, input: unknown, topic: string, deliveryId = randomUUID()) {
  const raw = JSON.stringify(input);
  return jsonResponse(await trackingHttp(f, `/api/tracking/hooks/${token}`, input, { "X-Shopify-Hmac-SHA256": createHmac("sha256", secret).update(raw).digest("base64"),
    "X-Shopify-Topic": topic, "X-Shopify-Shop-Domain": "release-fixture.myshopify.com", "X-Shopify-Webhook-Id": deliveryId, "X-Shopify-API-Version": "2026-10" }));
}
function order(f: EmailFixture, id: string, checkout: string) {
  return { id, admin_graphql_api_id: `gid://shopify/Order/${id}`, financial_status: "paid", test: true, updated_at: f.now().toISOString(), checkout_token: checkout,
    customer: { id: "550", admin_graphql_api_id: "gid://shopify/Customer/550", email: "maya@example.test", first_name: "Maya" },
    total_price_set: { shop_money: { amount: "50.00", currency_code: "GBP" }, presentment_money: { amount: "50.00", currency_code: "GBP" } } };
}
test("release proof: authenticated checkout joins verified payment, duplicate deliveries stay one fact/action, repeat purchase and successful refund stay distinct", async () => {
  const f = await createEmailFixture(); try {
    const from = f.now().toISOString(), api = await apiSource(f);
    const shop = await f.tracking.createSource(f.principal, { name: "Store", provider: "SHOPIFY", environment: "TEST", externalAccountId: "release-fixture.myshopify.com", credentials: { signingSecret: secret, apiToken: "fixture-only" } });
    const setup = await f.readyConnection(), draft = f.definition(setup.sender.id, "purchases");
    draft.steps[0].subject = "Thank you for your purchase";
    const campaign = await f.publishedCampaign({ setup, definition: draft });
    const { funnel, version } = await publishFunnel(f, "PURCHASE", { schemaVersion: 1, entryStages: ["checkout"],
      stages: [{ id: "checkout", name: "Checkout", goal: false, terminal: "NONE" }, { id: "paid", name: "Paid", goal: true, terminal: "NONE" }, { id: "refunded", name: "Refunded", goal: false, terminal: "SUCCESS" }],
      routes: [route("checkout", null, api.id, "checkout.observed", "checkout"), route("paid", "checkout", shop.source.id, "order.paid", "paid"), route("refund", "paid", shop.source.id, "refund.succeeded", "refunded")],
      stageActions: [{ id: "post-purchase", stageId: "paid", kind: "EMAIL_ENROLL", campaignId: campaign.campaign.id, revisionId: campaign.revision.id, delaySeconds: 0, expiresAfterDueSeconds: 3600, stopOnStageExit: true, stopOnGoal: false }] });
    const runner = runnerFor(f);
    async function checkout(id: string) {
      tick(f); const receipt = await apiEvent(f, api.id, { schemaVersion: 1, type: "checkout.observed", occurredAt: f.now().toISOString(), resource: { kind: "CHECKOUT", id: `api-${id}` }, subjectKind: "PURCHASE",
        references: [{ sourceId: shop.source.id, kind: "CHECKOUT", id }], contactIdentity: { kind: "CRM_CONTACT", id: "person-1" }, contact: { email: "maya@example.test" }, properties: { campaign: "store-campaign", utm_source: "search", utm_medium: "paid", utm_campaign: "store" } });
      await drain(f, runner); return f.db.trackingEvent.findUniqueOrThrow({ where: { id: receipt.receipts[0].id } });
    }
    const a = await checkout("checkout-101"); assert.ok(a.contactId); await consent(f, a.contactId, "purchases");
    tick(f); const paid = order(f, "101", "checkout-101"), deliveryId = randomUUID();
    const paidReceipt = await shopHook(f, shop.ingressToken!, paid, "orders/paid", deliveryId); await drain(f, runner);
    assert.equal((await f.db.trackingEvent.findUniqueOrThrow({ where: { id: paidReceipt.receipts[0].id } })).subjectId, a.subjectId);
    await shopHook(f, shop.ingressToken!, paid, "orders/paid", deliveryId);
    await shopHook(f, shop.ingressToken!, paid, "orders/paid"); await drain(f, runner);
    assert.equal(await f.db.trackingFact.count({ where: { type: "order.paid" } }), 1);
    assert.equal(await f.db.funnelActionExecution.count(), 1); assert.equal(await f.db.messageSend.count(), 1);
    assert.equal(await f.db.funnelStageTransition.count({ where: { toStageKey: "paid" } }), 1);
    const b = await checkout("checkout-102"); assert.notEqual(a.subjectId, b.subjectId); assert.equal(a.contactId, b.contactId);
    tick(f); await shopHook(f, shop.ingressToken!, order(f, "102", "checkout-102"), "orders/paid"); await drain(f, runner);
    assert.equal(await f.db.funnelSubject.count({ where: { kind: "PURCHASE" } }), 2); assert.equal(await f.db.funnelContact.count(), 1);
    assert.equal(await f.db.messageSend.count({ where: { status: "ACCEPTED" } }), 2);
    const customer = await f.db.funnelIdentity.findFirstOrThrow({ where: { sourceId: shop.source.id, namespace: "CUSTOMER" } }); assert.equal(customer.contactId, a.contactId);
    tick(f); const pending = { id: "301", order_id: "101", created_at: f.now().toISOString(), transactions: [{ id: "401", order_id: "101", kind: "refund", status: "pending", test: true, amount: "10.00", currency: "GBP", created_at: f.now().toISOString(), processed_at: null }] };
    await shopHook(f, shop.ingressToken!, pending, "refunds/create"); await drain(f, runner);
    assert.equal(await f.db.trackingFact.count({ where: { type: "refund.succeeded" } }), 0);
    tick(f); const refunded = { ...pending, transactions: [{ ...pending.transactions[0], status: "success", processed_at: f.now().toISOString() }] };
    await shopHook(f, shop.ingressToken!, refunded, "refunds/create"); await shopHook(f, shop.ingressToken!, refunded, "refunds/create"); await drain(f, runner);
    assert.equal(await f.db.trackingFact.count({ where: { type: "refund.succeeded" } }), 1); assert.equal(await f.db.trackingFact.count({ where: { type: "order.paid" } }), 2);
    assert.equal(await f.db.messageSend.count(), 2); assert.equal(f.requests.filter(request => request.method === "POST").length, 2);
    tick(f); const report = await new FunnelReportingService(f.db, f.auth, f.now).report(f.principal, funnel.id, { versionId: version.id, from, to: f.now().toISOString() });
    assert.equal(report.totals.journeys, 2); assert.equal(report.totals.goalJourneys, 2);
    assert.equal(report.stages.find(s => s.stageId === "paid")!.everReachedJourneys, 2); assert.equal(report.stages.find(s => s.stageId === "paid")!.currentJourneys, 1);
    assert.equal(report.stages.find(s => s.stageId === "refunded")!.currentJourneys, 1);
    const gbp = report.money.currencies.find(currency => currency.currency === "GBP")!;
    assert.equal(gbp.grossPaid.amount, "100"); assert.equal(gbp.successfulRefunds.amount, "10"); assert.equal(gbp.netObservedCash, "90");
    assert.equal(gbp.grossPaid.authorityCounts.PROVIDER_VERIFIED, 2); assert.equal(gbp.successfulRefunds.authorityCounts.PROVIDER_VERIFIED, 1);
    assert.equal(report.attribution.revenueCredit, "NONE");
    assert.ok((await f.tracking.audit(f.principal, api.id)).some(audit => audit.action === "API_HANDOFF_REFERENCE"));
  } finally { await f.close(); }
});
