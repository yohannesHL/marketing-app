import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac, randomUUID } from "node:crypto";
import { createEmailFixture } from "../support/email-fixture";
import { TrackingService } from "../../apps/web/src/server/funnels/trackingService";
import { createTrackingApi } from "../../apps/web/src/server/funnels/trackingApi";

type Fixture = Awaited<ReturnType<typeof createEmailFixture>>;
const secret = "handoff-fixture-signing-secret", site = "https://business.example.test";
async function sources(f: Fixture) {
  const api = (await f.tracking.createSource(f.principal, { name: "Business server", provider: "API", environment: "TEST", externalAccountId: randomUUID(), credentials: { signingSecret: secret }, config: { propertyKeys: ["amount", "currency"] } })).source;
  const native = (await f.tracking.createSource(f.principal, { name: "Forms", provider: "NATIVE", environment: "TEST", externalAccountId: randomUUID(), config: { allowedOrigins: [site] } })).source;
  return { api, native };
}
function payload(f: Fixture, id: string, references: unknown[] = [], identity = "person-a", recipient = "maya@example.test") {
  return { schemaVersion: 1, type: "enquiry.accepted", occurredAt: f.now().toISOString(), resource: { kind: "ENQUIRY", id }, subjectKind: "SALES", references, contactIdentity: { kind: "CRM_CONTACT", id: identity }, contact: { email: recipient, name: "Server name must not overwrite" } };
}
async function post(f: Fixture, sourceId: string, input: unknown, options: { id?: string; invalid?: boolean } = {}) {
  const raw = JSON.stringify(input), id = options.id ?? randomUUID(), seconds = String(Math.floor(f.now().getTime() / 1000));
  return createTrackingApi(f.auth, f.tracking)(new Request(`https://launchpad.test/api/tracking/ingest/${sourceId}/events`, { method: "POST", headers: { "content-type": "application/json", "x-launchpad-id": id, "x-launchpad-timestamp": seconds, "x-launchpad-signature": options.invalid ? "0".repeat(64) : createHmac("sha256", secret).update(`${seconds}.${id}.${raw}`).digest("hex") }, body: raw }));
}
async function queued(f: Fixture, sourceId: string, input: unknown, id?: string) {
  const response = await post(f, sourceId, input, { id });
  assert.equal(response.status, 202, await response.clone().text());
  const result = await response.json(); return result.receipts[0].id as string;
}
async function process(f: Fixture, id: string) {
  for (let n = 0; n < 30; n++) if (!await f.tracking.processOnce()) break;
  return f.db.trackingEvent.findUniqueOrThrow({ where: { id } });
}
async function form(f: Fixture, sourceId: string, id = "form-a", recipient = "maya@example.test") {
  const result = await f.tracking.collectNative(sourceId, site, JSON.stringify({ schemaVersion: 1, eventId: id, email: recipient, name: "Maya" }), true);
  return process(f, result.receipts[0].id);
}

test("signed native handoff binds an ingress identity to the existing contact without merging independent enquiries or replacing PII", async () => {
  const f = await createEmailFixture(); try {
    const s = await sources(f), original = await form(f, s.native.id);
    const a = await process(f, await queued(f, s.api.id, payload(f, "crm-a", [{ sourceId: s.native.id, kind: "ENQUIRY", id: "form-a" }])));
    assert.equal(a.status, "MATCHED"); assert.equal(a.subjectId, original.subjectId); assert.equal(a.contactId, original.contactId);
    const b = await process(f, await queued(f, s.api.id, payload(f, "crm-b")));
    assert.notEqual(a.subjectId, b.subjectId); assert.equal(a.contactId, b.contactId);
    assert.equal((await f.db.funnelContact.findUniqueOrThrow({ where: { id: a.contactId! } })).name, "Maya");
    assert.equal(await f.db.funnelContact.count(), 1);
    const handoff = (a.envelope as any).references[0]; assert.equal(handoff.sourceId, s.native.id); assert.equal(handoff.sourceGeneration, 1);
    const audit = await f.tracking.audit(f.principal, s.api.id);
    assert.ok(audit.some(row => row.action === "API_HANDOFF_REFERENCE")); assert.ok(audit.some(row => row.action === "IDENTITY_BOUND"));
  } finally { await f.close(); }
});

test("authentication precedes target lookup and target boundaries never become caller-controlled authority", async () => {
  const f = await createEmailFixture(); try {
    const s = await sources(f), other = await f.owner();
    const foreign = (await f.tracking.createSource(other.principal, { name: "Other", provider: "API", environment: "TEST", externalAccountId: randomUUID() })).source;
    const live = (await new TrackingService(f.db, f.auth, f.vault, f.now, true).createSource(f.principal, { name: "Live target", provider: "API", environment: "LIVE", externalAccountId: randomUUID() })).source;
    const shop = (await f.tracking.createSource(f.principal, { name: "Store", provider: "SHOPIFY", environment: "TEST", externalAccountId: "handoff.myshopify.com", credentials: { signingSecret: secret } })).source;
    await f.tracking.updateSource(f.principal, s.native.id, { status: "PAUSED" });
    for (const sourceId of [foreign.id, live.id, s.native.id, shop.id, "does-not-exist"]) {
      const input = payload(f, randomUUID(), [{ sourceId, kind: "ENQUIRY", id: "form" }]);
      assert.equal((await post(f, s.api.id, input, { invalid: true })).status, 401);
      assert.equal((await post(f, s.api.id, input)).status, 400);
    }
    for (const invalid of [
      { ...payload(f, "bad-resource"), resource: { kind: "ENQUIRY", id: "x", sourceId: s.api.id } },
      { ...payload(f, "bad-identity"), contactIdentity: { kind: "CRM", id: "x", sourceId: s.api.id } },
      payload(f, "bad-generation", [{ sourceId: s.api.id, sourceGeneration: 999, kind: "ENQUIRY", id: "x" }]),
    ]) assert.equal((await post(f, s.api.id, invalid)).status, 400);
    assert.equal(await f.db.trackingEvent.count(), 0);
  } finally { await f.close(); }
});

test("accepted reference generations survive replay and duplicate delivery without acquiring renewed target authority", async () => {
  const f = await createEmailFixture(); try {
    const s = await sources(f); await form(f, s.native.id);
    const input = payload(f, "late", [{ sourceId: s.native.id, kind: "ENQUIRY", id: "form-a" }]);
    const id = await queued(f, s.api.id, input, "stable-handoff-key");
    await f.tracking.updateSource(f.principal, s.native.id, { config: { allowedOrigins: [site] } });
    assert.equal(await queued(f, s.api.id, input, "stable-handoff-key"), id);
    let result = await process(f, id); assert.equal(result.status, "BLOCKED"); assert.equal(result.reason, "REFERENCE_SOURCE_CHANGED");
    await f.tracking.replay(f.principal, s.api.id, id); result = await process(f, id);
    assert.equal(result.status, "BLOCKED"); assert.equal((result.envelope as any).references[0].sourceGeneration, 1);
    assert.equal(await f.db.funnelIdentity.count({ where: { sourceId: s.api.id } }), 0);
    assert.equal(await f.db.funnelSubjectReference.count({ where: { sourceId: s.api.id } }), 0);
  } finally { await f.close(); }
});

test("existing subject handoffs reject prebound identity and recipient conflicts before creating aliases", async () => {
  const f = await createEmailFixture(); try {
    const s = await sources(f), a = await form(f, s.native.id);
    const unrelated = await process(f, await queued(f, s.api.id, payload(f, "existing-other")));
    assert.notEqual(unrelated.contactId, a.contactId);
    const bound = await process(f, await queued(f, s.api.id, payload(f, "poison-alias", [{ sourceId: s.native.id, kind: "ENQUIRY", id: "form-a" }])));
    assert.equal(bound.status, "QUARANTINED"); assert.equal(bound.reason, "CONTACT_IDENTITY_CONFLICT");
    const address = await process(f, await queued(f, s.api.id, payload(f, "poison-address", [{ sourceId: s.native.id, kind: "ENQUIRY", id: "form-a" }], "new-person", "other@example.test")));
    assert.equal(address.status, "QUARANTINED"); assert.equal(address.reason, "CONTACT_RECIPIENT_CONFLICT");
    assert.equal(await f.db.funnelSubjectReference.count({ where: { sourceId: s.api.id, externalId: { startsWith: "poison" } } }), 0);
    assert.equal(await f.db.funnelIdentity.count({ where: { sourceId: s.api.id, externalId: "new-person" } }), 0);
    assert.equal(await f.db.funnelContact.count(), 2);
  } finally { await f.close(); }
});

test("qualified pending handoffs are erased when their referenced native contact is deleted, even through an unrelated API source", async () => {
  const f = await createEmailFixture(); try {
    const s = await sources(f), a = await form(f, s.native.id);
    const id = await queued(f, s.api.id, payload(f, "pending", [{ sourceId: s.native.id, kind: "ENQUIRY", id: "form-a" }]));
    await f.tracking.deleteContact(f.principal, a.contactId!);
    assert.deepEqual((await f.db.trackingEvent.findUniqueOrThrow({ where: { id } })).envelope, {});
    const later = await process(f, await queued(f, s.api.id, payload(f, "after-deletion", [{ sourceId: s.native.id, kind: "ENQUIRY", id: "form-a" }])));
    assert.equal(later.status, "REDACTED"); assert.equal(await f.db.funnelIdentity.count(), 0);
    assert.equal(await f.db.funnelContact.count({ where: { deletedAt: null } }), 0);
  } finally { await f.close(); }
});

test("conflicting financial facts cannot establish new qualified aliases or stable identities", async () => {
  const f = await createEmailFixture(); try {
    const s = await sources(f), original = await process(f, await queued(f, s.api.id, payload(f, "enquiry")));
    const paid = { ...payload(f, "enquiry"), type: "deal.won", properties: { amount: "2500.00", currency: "GBP" } };
    await process(f, await queued(f, s.api.id, paid));
    const conflict = await process(f, await queued(f, s.api.id, { ...paid, contactIdentity: { kind: "CRM_CONTACT", id: "new-alias" }, references: [{ sourceId: s.native.id, kind: "ENQUIRY", id: "poison-native" }], properties: { amount: "9999.00", currency: "GBP" } }));
    assert.equal(conflict.status, "QUARANTINED"); assert.equal(conflict.reason, "FINANCIAL_FACT_CONFLICT");
    assert.equal(await f.db.funnelSubjectReference.count({ where: { externalId: "poison-native" } }), 0);
    assert.equal(await f.db.funnelIdentity.count({ where: { externalId: "new-alias" } }), 0);
    assert.equal(((await f.db.trackingFact.findFirstOrThrow({ where: { subjectId: original.subjectId! } })).attributes as Record<string, unknown>).amount, "2500.00");
  } finally { await f.close(); }
});

test("manual matching may resolve ambiguity but cannot attach a second same-store order to an existing purchase", async () => {
  const f = await createEmailFixture(); try {
    const s = await sources(f), shop = (await f.tracking.createSource(f.principal, { name: "Store", provider: "SHOPIFY", environment: "TEST", externalAccountId: "order-conflict.myshopify.com", credentials: { signingSecret: secret } })).source;
    const purchase = (id: string, references: unknown[]) => ({ schemaVersion: 1, type: "checkout.observed", occurredAt: f.now().toISOString(), resource: { kind: "CHECKOUT", id }, subjectKind: "PURCHASE", references });
    const ref = (kind: string, id: string) => ({ sourceId: shop.id, kind, id });
    const first = await process(f, await queued(f, s.api.id, purchase("api-first", [ref("CHECKOUT", "checkout-a"), ref("ORDER", "gid://shopify/Order/101")])));
    await process(f, await queued(f, s.api.id, purchase("api-second", [ref("CHECKOUT", "checkout-b")])));
    const conflict = await process(f, await queued(f, s.api.id, purchase("api-conflict", [ref("CHECKOUT", "checkout-a"), ref("CHECKOUT", "checkout-b"), ref("ORDER", "gid://shopify/Order/102")])));
    assert.equal(conflict.status, "UNMATCHED"); assert.equal(conflict.reason, "AMBIGUOUS_BUSINESS_REFERENCES");
    await f.tracking.match(f.principal, s.api.id, conflict.id, { subjectId: first.subjectId, reason: "Operator selects the first purchase" });
    const matched = await process(f, conflict.id); assert.equal(matched.status, "UNMATCHED"); assert.equal(matched.reason, "ORDER_REFERENCE_CONFLICT");
    assert.equal(await f.db.funnelSubjectReference.count({ where: { sourceId: shop.id, externalId: "gid://shopify/Order/102" } }), 0);
    assert.equal(await f.db.funnelSubjectReference.count({ where: { sourceId: s.api.id, externalId: "api-conflict" } }), 0);
    assert.equal(await f.db.funnelSubject.count(), 2);
  } finally { await f.close(); }
});

test("a deleted stable identity cannot reappear through an otherwise valid existing-subject handoff", async () => {
  const f = await createEmailFixture(); try {
    const s = await sources(f), native = await form(f, s.native.id);
    const independent = await process(f, await queued(f, s.api.id, payload(f, "independent")));
    await f.tracking.deleteContact(f.principal, independent.contactId!);
    const incoming = await process(f, await queued(f, s.api.id, payload(f, "after-delete", [{ sourceId: s.native.id, kind: "ENQUIRY", id: "form-a" }])));
    assert.equal(incoming.status, "REDACTED"); assert.equal(incoming.reason, "DELETED_CONTACT");
    assert.equal(await f.db.funnelIdentity.count(), 0);
    assert.equal(await f.db.funnelSubjectReference.count({ where: { sourceId: s.api.id, externalId: "after-delete" } }), 0);
    assert.equal((await f.db.funnelContact.findUniqueOrThrow({ where: { id: native.contactId! } })).deletedAt, null);
  } finally { await f.close(); }
});

test("repeated qualified references have one binding and retain the strongest accepted source fence", async () => {
  const f = await createEmailFixture(); try {
    const s = await sources(f); await form(f, s.native.id);
    const ref = { sourceId: s.native.id, kind: "ENQUIRY", id: "form-a" };
    const event = await process(f, await queued(f, s.api.id, payload(f, "repeat", [ref, ref, ref])));
    assert.equal(event.status, "MATCHED"); assert.equal((event.envelope as any).references.length, 1);
    assert.equal(await f.db.funnelSubjectReference.count({ where: { sourceId: s.native.id, externalId: "form-a" } }), 1);
    assert.equal(await f.db.trackingAudit.count({ where: { eventId: event.id, action: "API_HANDOFF_REFERENCE" } }), 1);
    const mixed = await process(f, await queued(f, s.api.id, payload(f, "repeat", [{ sourceId: s.api.id, kind: "ENQUIRY", id: "repeat" }, { kind: "ENQUIRY", id: "repeat" }])));
    assert.equal((mixed.envelope as any).references.length, 1); assert.equal((mixed.envelope as any).references[0].sourceGeneration, 1);
  } finally { await f.close(); }
});

test("a manual receipt override cannot copy one existing provider order's canonical money onto another purchase", async () => {
  const f = await createEmailFixture(); try {
    const s = await sources(f), shop = (await f.tracking.createSource(f.principal, { name: "Store", provider: "SHOPIFY", environment: "TEST", externalAccountId: "money-conflict.myshopify.com", credentials: { signingSecret: secret } })).source;
    const original = { schemaVersion: 1, type: "order.paid", occurredAt: f.now().toISOString(), resource: { kind: "ORDER", id: "api-order-101" }, subjectKind: "PURCHASE", references: [{ sourceId: shop.id, kind: "ORDER", id: "gid://shopify/Order/101" }], properties: { amount: "50.00", currency: "GBP" } };
    const first = await process(f, await queued(f, s.api.id, original));
    const other = await process(f, await queued(f, s.api.id, { schemaVersion: 1, type: "checkout.observed", occurredAt: f.now().toISOString(), resource: { kind: "CHECKOUT", id: "other-checkout" }, subjectKind: "PURCHASE" }));
    const ambiguous = await process(f, await queued(f, s.api.id, { ...original, references: [...original.references, { kind: "CHECKOUT", id: "other-checkout" }] }));
    assert.equal(ambiguous.status, "UNMATCHED");
    await f.tracking.match(f.principal, s.api.id, ambiguous.id, { subjectId: other.subjectId, reason: "Operator attempts to move payment to another purchase" });
    const result = await process(f, ambiguous.id); assert.equal(result.status, "UNMATCHED"); assert.equal(result.reason, "FINANCIAL_REFERENCE_CONFLICT");
    assert.equal(await f.db.trackingFact.count({ where: { type: "order.paid" } }), 1);
    assert.equal((await f.db.trackingFact.findFirstOrThrow()).subjectId, first.subjectId);
    assert.equal((await f.db.funnelSubjectReference.findFirstOrThrow({ where: { sourceId: shop.id, kind: "ORDER" } })).subjectId, first.subjectId);
  } finally { await f.close(); }
});
