import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { PrismaClient } from "../../apps/web/src/generated/prisma/client";
import { LocalSqliteAdapter } from "../../apps/web/src/server/prisma/localSqliteAdapter";
import { CustomerAuth, digest, type CustomerPrincipal } from "../../apps/web/src/server/auth/customerAuth";
import { CredentialVault } from "../../apps/web/src/server/security/credentialVault";
import { TrackingService } from "../../apps/web/src/server/funnels/trackingService";
import { createTrackingApi } from "../../apps/web/src/server/funnels/trackingApi";
import { applyConnectionMigrations } from "../support/test-database";

let dir: string, db: PrismaClient, db2: PrismaClient, auth: CustomerAuth, service: TrackingService, second: TrackingService;
let now = new Date("2026-10-17T12:00:00Z");
const origin = "https://launchpad.test", site = "https://business.example.test";
const secret = "fixture-signing-secret";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "funnel-tracking-")); const url = `file:${join(dir, "fixture.db")}`;
  const client = createClient({ url }); await applyConnectionMigrations(client); client.close();
  db = new PrismaClient({ adapter: new LocalSqliteAdapter({ url }) }); db2 = new PrismaClient({ adapter: new LocalSqliteAdapter({ url }) });
  auth = new CustomerAuth(db, { origin }, () => now);
  const vault = new CredentialVault({ fixture: Buffer.alloc(32, 19).toString("base64") }, "fixture");
  service = new TrackingService(db, auth, vault, () => now);
  second = new TrackingService(db2, new CustomerAuth(db2, { origin }, () => now), vault, () => now);
});
after(async () => { await db?.$disconnect(); await db2?.$disconnect(); if (dir) await rm(dir, { recursive: true, force: true }); });

async function owner() {
  const token = randomBytes(32).toString("base64url"), id = randomUUID();
  await db.user.create({ data: { id, email: `${id}@example.test`, name: "Fixture owner" } });
  const session = await db.customerSession.create({ data: { userId: id, tokenHash: digest(token), expiresAt: new Date("2027-10-17T12:00:00Z") } });
  return { principal: { userId: id, sessionId: session.id } as CustomerPrincipal, cookie: `${auth.cookieName}=${token}` };
}
async function native(p: CustomerPrincipal) {
  return (await service.createSource(p, { name: "Website", provider: "NATIVE", environment: "TEST", externalAccountId: randomUUID(), config: { allowedOrigins: [site] } })).source;
}
async function api(p: CustomerPrincipal) {
  return (await service.createSource(p, { name: "Server", provider: "API", environment: "TEST", externalAccountId: randomUUID(),
    credentials: { signingSecret: secret }, config: { propertyKeys: ["amount", "currency", "plan"] } })).source;
}
function signature(raw: string, id = randomUUID()) {
  const t = String(Math.floor(now.getTime() / 1000));
  return new Headers({ "x-launchpad-id": id, "x-launchpad-timestamp": t,
    "x-launchpad-signature": createHmac("sha256", secret).update(`${t}.${id}.${raw}`).digest("hex") });
}
const enquiry = (id: string, contact = "maya") => ({ schemaVersion: 1, type: "enquiry.accepted", occurredAt: now.toISOString(),
  resource: { kind: "ENQUIRY", id }, subjectKind: "SALES", contactIdentity: { kind: "CRM_CONTACT", id: contact }, contact: { email: "maya@example.test", name: "Maya" } });
async function accepted(sourceId: string, input: unknown, id?: string) {
  const raw = JSON.stringify(input); const receipt = await service.collectApi(sourceId, signature(raw, id), raw);
  await service.processOnce(); return db.trackingEvent.findUniqueOrThrow({ where: { id: receipt.receipts[0].id } });
}
async function drain() { for (let n = 0; n < 50; n++) if (!await service.processOnce()) return; throw new Error("Fixture failed to drain"); }
async function calendly(p: CustomerPrincipal) {
  return service.createSource(p, { name: "Bookings", provider: "CALENDLY", environment: "TEST", externalAccountId: "https://api.calendly.com/users/host-a",
    config: { correlationField: "utm_content" }, credentials: { signingSecret: secret, apiToken: "test-api-token" } });
}
function booking(id: string, token?: string, recipient = "maya@example.test", old?: string, cancelled = false) {
  const event = "https://api.calendly.com/scheduled_events/shared-event";
  return { event: cancelled ? "invitee.canceled" : "invitee.created", created_at: now.toISOString(), payload: {
    uri: `${event}/invitees/${id}`, event, status: cancelled ? "canceled" : "active", created_at: now.toISOString(), updated_at: now.toISOString(),
    email: recipient, name: "Maya", rescheduled: !!old, old_invitee: old ? `${event}/invitees/${old}` : null, new_invitee: null,
    ...(cancelled ? { cancellation: { canceled_by: "Maya", canceler_type: "invitee", created_at: now.toISOString() } } : {}),
    tracking: { utm_content: token ?? null }, scheduled_event: { uri: event, event_memberships: [{ user: "https://api.calendly.com/users/host-a" }] },
  } };
}
async function hook(token: string, input: unknown) {
  const raw = JSON.stringify(input), t = String(Math.floor(now.getTime() / 1000));
  return service.collectHook(token, new Headers({ "Calendly-Webhook-Signature": `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}` }), raw);
}

test("accepted native form links an anonymous visit, persists before worker, and never trusts browser ownership or payment", async () => {
  const o = await owner(), source = await native(o.principal), visitor = await service.visitor(source.id, site);
  const page = await service.collectNative(source.id, site, JSON.stringify({ schemaVersion: 1, eventId: "page-1", visitorToken: visitor.visitorToken, type: "page.viewed", properties: { path: "/guide" } }), false);
  assert.equal((await db.trackingEvent.findUniqueOrThrow({ where: { id: page.receipts[0].id } })).status, "QUEUED");
  await drain(); assert.equal((await db.trackingEvent.findUniqueOrThrow({ where: { id: page.receipts[0].id } })).contactId, null);
  const form = await service.collectNative(source.id, site, JSON.stringify({ schemaVersion: 1, eventId: "form-1", visitorToken: visitor.visitorToken, name: "Maya", email: "maya@example.test" }), true);
  assert.equal(await db.funnelContact.count({ where: { ownerId: o.principal.userId } }), 0);
  await drain(); const result = await db.trackingEvent.findUniqueOrThrow({ where: { id: form.receipts[0].id } });
  assert.equal(result.status, "MATCHED"); assert.ok(result.subjectId && result.contactId);
  const linked = await db.trackingEvent.findUniqueOrThrow({ where: { id: page.receipts[0].id } });
  assert.equal(linked.subjectId, result.subjectId); assert.equal(linked.processingMode, "REPLAY");
  await assert.rejects(service.collectNative(source.id, site, JSON.stringify({ schemaVersion: 1, eventId: "fake", type: "order.paid" }), false), { code: "UNSUPPORTED_EVENT" });
  await assert.rejects(service.collectNative(source.id, site, JSON.stringify({ schemaVersion: 1, eventId: "fake", type: "page.viewed", ownerId: "other" }), false), { code: "INVALID_TRACKING_INPUT" });
  await assert.rejects(service.visitor(source.id, "https://evil.test"), { code: "INVALID_ORIGIN" });
  assert.equal(await db.trackingFact.count({ where: { ownerId: o.principal.userId } }), 0);
});

test("same customer identity supports two independent enquiries; email alone never merges contacts", async () => {
  const o = await owner(), s = await api(o.principal);
  const a = await accepted(s.id, enquiry("enquiry-a")), b = await accepted(s.id, enquiry("enquiry-b"));
  assert.equal(a.contactId, b.contactId); assert.notEqual(a.subjectId, b.subjectId);
  const c = await accepted(s.id, enquiry("enquiry-c", "another-person")); assert.notEqual(c.contactId, a.contactId);
  const other = await owner(), foreign = await api(other.principal), d = await accepted(foreign.id, enquiry("enquiry-a"));
  assert.notEqual(a.subjectId, d.subjectId); assert.notEqual(a.contactId, d.contactId);
  await assert.rejects(service.events(other.principal, s.id), { code: "NOT_FOUND" });
  await assert.rejects(db.funnelSubjectReference.create({ data: { ownerId: other.principal.userId, environment: "TEST", sourceId: foreign.id,
    subjectId: a.subjectId!, kind: "ENQUIRY", externalId: "cross-owner" } }));
  await assert.rejects(db.funnelSubject.create({ data: { ownerId: o.principal.userId, environment: "LIVE", kind: "SALES", contactId: a.contactId } }));
});

test("parallel retries across independent database clients accept and process a business event once", async () => {
  const o = await owner(), s = await api(o.principal), raw = JSON.stringify(enquiry("parallel")), headers = signature(raw, "stable-request");
  const receipts = await Promise.all([service.collectApi(s.id, headers, raw), second.collectApi(s.id, headers, raw)]);
  assert.equal(receipts[0].receipts[0].id, receipts[1].receipts[0].id);
  await Promise.all([service.processOnce(), second.processOnce()]);
  assert.equal(await db.funnelSubject.count({ where: { ownerId: o.principal.userId } }), 1);
  const changed = JSON.stringify(enquiry("different"));
  await assert.rejects(service.collectApi(s.id, signature(changed, "stable-request"), changed), { code: "IDEMPOTENCY_CONFLICT" });
  const evidence = await service.events(o.principal, s.id); assert.equal(evidence.events[0].duplicates, 1); assert.equal(evidence.events[0].conflicts, 1);
  assert.ok((await service.audit(o.principal, s.id)).some(a => a.action === "DELIVERY_CONFLICT"));
});

test("server signatures bind timestamp, request ID and exact body; source DTOs and evidence omit credentials", async () => {
  const o = await owner(), s = await api(o.principal), raw = JSON.stringify(enquiry("auth"));
  const headers = signature(raw); headers.set("x-launchpad-id", "changed-request");
  await assert.rejects(service.collectApi(s.id, headers, raw), { code: "INVALID_TRACKING_SIGNATURE" });
  const old = signature(raw); old.set("x-launchpad-timestamp", "1000000000");
  await assert.rejects(service.collectApi(s.id, old, raw), { code: "INVALID_TRACKING_SIGNATURE" });
  await assert.rejects(service.collectApi(s.id, signature(raw), raw + " "), { code: "INVALID_TRACKING_SIGNATURE" });
  const forged = JSON.stringify({ ...enquiry("auth"), ownerId: "someone-else" });
  await assert.rejects(service.collectApi(s.id, signature(forged), forged), { code: "INVALID_TRACKING_INPUT" });
  assert.doesNotMatch(JSON.stringify(await service.listSources(o.principal)), /signing-secret|Ciphertext|ingressTokenHash/);
  await db.customerSession.delete({ where: { id: o.principal.sessionId } });
  await assert.rejects(service.updateSource(o.principal, s.id, { status: "PAUSED" }), { code: "UNAUTHENTICATED" });
});

test("verified booking correlation picks the correct enquiry, rejects forwarded recipient and never merges shared scheduled-event invitees", async () => {
  const o = await owner(), s = await api(o.principal), a = await accepted(s.id, enquiry("first")), b = await accepted(s.id, enquiry("second"));
  const c = await calendly(o.principal), correlation = await service.createCorrelation(o.principal, c.source.id, { subjectId: a.subjectId });
  const receipt = await hook(c.ingressToken!, booking("invitee-a", correlation.token)); await drain();
  const matched = await db.trackingEvent.findUniqueOrThrow({ where: { id: receipt.receipts[0].id } }); assert.equal(matched.subjectId, a.subjectId);
  const forwarded = await hook(c.ingressToken!, booking("invitee-b", correlation.token, "somebody-else@example.test")); await drain();
  const rejected = await db.trackingEvent.findUniqueOrThrow({ where: { id: forwarded.receipts[0].id } });
  assert.equal(rejected.status, "UNMATCHED"); assert.equal(rejected.subjectId, null);
  const uncorrelated = await hook(c.ingressToken!, booking("invitee-c")); await drain();
  assert.equal((await db.trackingEvent.findUniqueOrThrow({ where: { id: uncorrelated.receipts[0].id } })).subjectId, null);
  await service.match(o.principal, c.source.id, uncorrelated.receipts[0].id, { subjectId: b.subjectId, reason: "Customer confirmed the second enquiry." }); await drain();
  const manual = await db.trackingEvent.findUniqueOrThrow({ where: { id: uncorrelated.receipts[0].id } });
  assert.equal(manual.subjectId, b.subjectId); assert.equal(manual.processingMode, "REPLAY");
  assert.ok((await service.audit(o.principal, c.source.id)).some(a => a.action === "MANUAL_MATCH"));
});

test("rescheduled booking resolves through verified old/new invitee references in either arrival order", async () => {
  for (const reverse of [false, true]) {
    const o = await owner(), s = await api(o.principal), enquiryEvent = await accepted(s.id, enquiry("rescheduled")), c = await calendly(o.principal);
    const correlation = await service.createCorrelation(o.principal, c.source.id, { subjectId: enquiryEvent.subjectId });
    const old = booking("old", correlation.token, "maya@example.test", undefined, true);
    old.payload.rescheduled = true; old.payload.new_invitee = "https://api.calendly.com/scheduled_events/shared-event/invitees/new" as never;
    const newer = booking("new", undefined, "maya@example.test", "old");
    const entries = reverse ? [newer, old] : [old, newer];
    const ids: string[] = [];
    for (const entry of entries) { const r = await hook(c.ingressToken!, entry); ids.push(r.receipts[0].id); await drain(); }
    // The early unmatched record is explicitly replayable after the second receipt establishes references.
    for (const id of ids) { const e = await db.trackingEvent.findUniqueOrThrow({ where: { id } }); if (e.status === "UNMATCHED") { await service.replay(o.principal, c.source.id, id); await drain(); } }
    for (const id of ids) assert.equal((await db.trackingEvent.findUniqueOrThrow({ where: { id } })).subjectId, enquiryEvent.subjectId);
  }
});

test("canonical paid facts deduplicate new deliveries; repeated purchases stay separate; late/future/conflicting evidence is visible", async () => {
  const o = await owner(), s = await api(o.principal);
  const order = (id: string, amount = "100.00") => ({ ...enquiry(id), type: "order.paid", subjectKind: "PURCHASE", resource: { kind: "ORDER", id }, properties: { amount, currency: "GBP" } });
  const a = await accepted(s.id, order("order-1")), duplicate = await accepted(s.id, order("order-1")), b = await accepted(s.id, order("order-2"));
  assert.equal(a.factId, duplicate.factId); assert.equal(a.contactId, b.contactId); assert.notEqual(a.subjectId, b.subjectId);
  assert.equal(await db.trackingFact.count({ where: { ownerId: o.principal.userId } }), 2);
  const conflict = await accepted(s.id, order("order-1", "999.00")); assert.equal(conflict.status, "QUARANTINED");
  assert.equal((await db.trackingFact.findUniqueOrThrow({ where: { id: a.factId! } })).attributes && ((await db.trackingFact.findUniqueOrThrow({ where: { id: a.factId! } })).attributes as Record<string, unknown>).amount, "100.00");
  const late = await accepted(s.id, { ...order("order-1"), type: "checkout.observed", occurredAt: "2026-10-16T12:00:00Z" }); assert.equal(late.late, true);
  const future = await accepted(s.id, { ...order("future"), occurredAt: "2027-01-01T00:00:00Z" }); assert.equal(future.status, "QUARANTINED");
});

test("source rotation preserves accepted proof and supports audited history-only replay without rewriting evidence", async () => {
  const o = await owner(), s = await api(o.principal), raw = JSON.stringify(enquiry("rotation"));
  const receipt = await service.collectApi(s.id, signature(raw), raw); await service.updateSource(o.principal, s.id, { status: "PAUSED" }); await drain();
  assert.equal((await db.trackingEvent.findUniqueOrThrow({ where: { id: receipt.receipts[0].id } })).status, "BLOCKED");
  await service.updateSource(o.principal, s.id, { status: "ACTIVE" });
  await service.replay(o.principal, s.id, receipt.receipts[0].id); await drain();
  const restored = await db.trackingEvent.findUniqueOrThrow({ where: { id: receipt.receipts[0].id } });
  assert.equal(restored.status, "MATCHED"); assert.equal(restored.processingMode, "REPLAY"); assert.equal(restored.sourceGeneration, 1);
  await assert.rejects(db.trackingEvent.update({ where: { id: restored.id }, data: { rawPayloadDigest: "forged" } }));
});

test("contact deletion removes payload/mappings and blocks replay or later recreation through its external identity", async () => {
  const o = await owner(), s = await api(o.principal), event = await accepted(s.id, enquiry("delete-me"));
  await service.deleteContact(o.principal, event.contactId!);
  const contact = await db.funnelContact.findUniqueOrThrow({ where: { id: event.contactId! } });
  assert.equal(contact.email, null); assert.ok(contact.deletedAt);
  assert.equal(await db.funnelIdentity.count({ where: { contactId: event.contactId } }), 0);
  assert.deepEqual((await db.trackingEvent.findUniqueOrThrow({ where: { id: event.id } })).envelope, {});
  await assert.rejects(service.replay(o.principal, s.id, event.id), { code: "REPLAY_UNAVAILABLE" });
  const subsequent = await accepted(s.id, enquiry("new-enquiry-same-deleted-identity"));
  assert.equal(subsequent.status, "REDACTED"); assert.equal(await db.funnelContact.count({ where: { ownerId: o.principal.userId, deletedAt: null } }), 0);
});

test("retention preserves dedupe tombstones and rejects unbounded native ingress", async () => {
  const o = await owner(), s = await native(o.principal);
  const raw = JSON.stringify({ schemaVersion: 1, eventId: "expired-page", type: "page.viewed" });
  const receipt = await service.collectNative(s.id, site, raw, false); await drain();
  await db.trackingEvent.update({ where: { id: receipt.receipts[0].id }, data: { expiresAt: new Date("2020-01-01") } });
  await service.prune(); assert.equal((await db.trackingEvent.findUniqueOrThrow({ where: { id: receipt.receipts[0].id } })).status, "REDACTED");
  const retry = await service.collectNative(s.id, site, raw, false); assert.equal(retry.receipts[0].duplicate, true);
  const bucket = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  await db.trackingRateLimit.update({ where: { sourceId_bucket: { sourceId: s.id, bucket } }, data: { count: 120 } });
  await assert.rejects(service.visitor(s.id, site), { code: "TRACKING_RATE_LIMIT" });
});

test("HTTP routes enforce session, origin, source boundaries, body limits and native-only CORS", async () => {
  const o = await owner(), foreign = await owner(), s = await native(o.principal), handler = createTrackingApi(auth, service);
  const req = (path: string, body?: unknown, cookie = o.cookie, requestOrigin = origin, method = body === undefined ? "GET" : "POST") =>
    new Request(`${origin}${path}`, { method, headers: { cookie, origin: requestOrigin, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal((await handler(new Request(`${origin}/api/tracking/sources`))).status, 401);
  assert.equal((await handler(req("/api/tracking/sources", {}, o.cookie, "https://evil.test"))).status, 403);
  assert.equal((await handler(req(`/api/tracking/sources/${s.id}/events`, undefined, foreign.cookie))).status, 404);
  const page = { schemaVersion: 1, eventId: "http-page", type: "page.viewed" };
  const response = await handler(req(`/api/tracking/ingest/${s.id}/collect`, page, "", site));
  assert.equal(response.status, 202); assert.equal(response.headers.get("access-control-allow-origin"), site);
  assert.equal(response.headers.get("access-control-allow-credentials"), null); assert.equal(response.headers.get("cache-control"), "no-store");
  const forbidden = await handler(req(`/api/tracking/ingest/${s.id}/collect`, page, "", "https://evil.test"));
  assert.equal(forbidden.status, 403); assert.equal(forbidden.headers.get("access-control-allow-origin"), null);
  const large = await handler(req(`/api/tracking/ingest/${s.id}/form`, { email: "x".repeat(33000) }, "", site)); assert.equal(large.status, 413);
  const preflight = await handler(new Request(`${origin}/api/tracking/ingest/${s.id}/collect`, { method: "OPTIONS", headers: {
    origin: site, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } }));
  assert.equal(preflight.status, 204);
  const listing = await handler(req("/api/tracking/sources")); assert.equal(listing.status, 200); assert.equal(listing.headers.get("cache-control"), "no-store");
  await drain();
});

test("contact references cannot collapse purchases and invalid signed attempts cannot consume source quota", async () => {
  const o = await owner(), s = await api(o.principal);
  const bad = JSON.stringify({ ...enquiry("order-a"), type: "order.paid", subjectKind: "PURCHASE", resource: { kind: "ORDER", id: "order-a" },
    references: [{ kind: "CONTACT", id: "same-customer" }], properties: { amount: "10.00", currency: "GBP" } });
  await assert.rejects(service.collectApi(s.id, signature(bad), bad), { code: "INVALID_TRACKING_INPUT" });
  const before = await db.trackingRateLimit.findFirst({ where: { sourceId: s.id } });
  const invalid = signature(bad); invalid.set("x-launchpad-signature", "0".repeat(64));
  await assert.rejects(service.collectApi(s.id, invalid, bad), { code: "INVALID_TRACKING_SIGNATURE" });
  assert.equal((await db.trackingRateLimit.findFirst({ where: { sourceId: s.id } }))?.count, before?.count);
  for (const occurredAt of ["2026-02-30T12:00:00Z", "2026-10-17T12:00:00", "2026-10-17T25:00:00Z"]) {
    const raw = JSON.stringify({ ...enquiry("invalid-date"), occurredAt });
    await assert.rejects(service.collectApi(s.id, signature(raw), raw), { code: "INVALID_TRACKING_INPUT" });
  }
});

test("deleting a contact fences business references even when a new delivery omits customer identity", async () => {
  const o = await owner(), s = await api(o.principal), event = await accepted(s.id, enquiry("old-enquiry"));
  await service.deleteContact(o.principal, event.contactId!);
  const { contact, contactIdentity, ...withoutIdentity } = enquiry("old-enquiry");
  const repeat = await accepted(s.id, withoutIdentity);
  assert.equal(repeat.status, "REDACTED"); assert.equal(repeat.reason, "DELETED_SUBJECT");
  assert.equal(await db.funnelSubject.count({ where: { ownerId: o.principal.userId } }), 1);
});

test("signed store receipts preserve repeat orders, checkout mapping, refund evidence and canonical deduplication", async () => {
  const o = await owner();
  const connection = await service.createSource(o.principal, { name: "Store", provider: "SHOPIFY", environment: "TEST",
    externalAccountId: "fixture-shop.myshopify.com", credentials: { signingSecret: secret } });
  const ingest = async (value: unknown, topic = "orders/paid", delivery = randomUUID()) => {
    const raw = JSON.stringify(value), headers = new Headers({ "X-Shopify-Hmac-SHA256": createHmac("sha256", secret).update(raw).digest("base64"),
      "X-Shopify-Topic": topic, "X-Shopify-Shop-Domain": "fixture-shop.myshopify.com", "X-Shopify-Webhook-Id": delivery, "X-Shopify-API-Version": "2026-10" });
    const receipt = await service.collectHook(connection.ingressToken!, headers, raw); await drain(); return receipt;
  };
  const paid = (id: string) => ({ id, admin_graphql_api_id: `gid://shopify/Order/${id}`, financial_status: "paid", test: true,
    updated_at: now.toISOString(), checkout_token: `checkout-${id}`, customer: { id: "550", admin_graphql_api_id: "gid://shopify/Customer/550", email: "maya@example.test", first_name: "Maya" },
    total_price_set: { shop_money: { amount: "50.00", currency_code: "GBP" }, presentment_money: { amount: "50.00", currency_code: "GBP" } } });
  const first = await ingest(paid("101")), second = await ingest(paid("102")); await ingest(paid("101"));
  const a = await db.trackingEvent.findUniqueOrThrow({ where: { id: first.receipts[0].id } }), b = await db.trackingEvent.findUniqueOrThrow({ where: { id: second.receipts[0].id } });
  assert.equal(a.status, "MATCHED"); assert.ok(a.contactId); assert.equal(a.contactId, b.contactId); assert.notEqual(a.subjectId, b.subjectId);
  assert.equal(await db.trackingFact.count({ where: { ownerId: o.principal.userId, type: "order.paid" } }), 2);
  assert.equal((await db.funnelSubjectReference.findFirst({ where: { sourceId: connection.source.id, kind: "CHECKOUT", externalId: "checkout-101" } }))?.subjectId, a.subjectId);
  const refund = { id: "301", order_id: "101", created_at: now.toISOString(), processed_at: null, transactions: [
    { id: "401", order_id: "101", kind: "refund", status: "pending", test: true, amount: "10.00", currency: "GBP", created_at: now.toISOString(), processed_at: null as string | null } ] };
  await ingest(refund, "refunds/create"); assert.equal(await db.trackingFact.count({ where: { ownerId: o.principal.userId, type: "refund.succeeded" } }), 0);
  refund.transactions[0].status = "success"; refund.transactions[0].processed_at = now.toISOString();
  await ingest(refund, "refunds/create"); await ingest(refund, "refunds/create");
  const facts = await db.trackingFact.findMany({ where: { ownerId: o.principal.userId, type: "refund.succeeded" } });
  assert.equal(facts.length, 1); assert.equal(facts[0].subjectId, a.subjectId); assert.equal((facts[0].attributes as Record<string, unknown>).amount, "10.00");
});

test("manual booking matching rejects purchase subjects and deletion redacts queued identity evidence on a paused source", async () => {
  const o = await owner(), s = await api(o.principal), original = await accepted(s.id, enquiry("existing"));
  const purchase = await accepted(s.id, { ...enquiry("purchase"), resource: { kind: "ORDER", id: "purchase" }, subjectKind: "PURCHASE", type: "order.paid", properties: { amount: "1.00", currency: "GBP", plan: "private customer detail" } });
  const c = await calendly(o.principal), booked = await hook(c.ingressToken!, booking("wrong-kind")); await drain();
  await assert.rejects(service.match(o.principal, c.source.id, booked.receipts[0].id, { subjectId: purchase.subjectId, reason: "Must fail" }), { code: "INVALID_MATCH" });
  const raw = JSON.stringify(enquiry("unprocessed")), pending = await service.collectApi(s.id, signature(raw), raw);
  await service.updateSource(o.principal, s.id, { status: "PAUSED" });
  await service.deleteContact(o.principal, original.contactId!);
  const redacted = await db.trackingEvent.findUniqueOrThrow({ where: { id: pending.receipts[0].id } });
  assert.equal(redacted.status, "REDACTED"); assert.deepEqual(redacted.envelope, {});
  assert.equal((await db.trackingFact.findFirstOrThrow({ where: { subjectId: purchase.subjectId! } })).attributes &&
    Object.keys((await db.trackingFact.findFirstOrThrow({ where: { subjectId: purchase.subjectId! } })).attributes as object).includes("plan"), false);
});

test("ambiguous business references stay unresolved until an audited receipt-only choice", async () => {
  const o = await owner(), s = await api(o.principal), a = await accepted(s.id, enquiry("a")), b = await accepted(s.id, enquiry("b"));
  const ambiguous = await accepted(s.id, { ...enquiry("c"), references: [{ kind: "ENQUIRY", id: "a" }, { kind: "ENQUIRY", id: "b" }] });
  assert.equal(ambiguous.status, "UNMATCHED");
  await service.match(o.principal, s.id, ambiguous.id, { subjectId: a.subjectId, reason: "Reviewed the conflicting reference; associate this receipt with enquiry a." }); await drain();
  const repaired = await db.trackingEvent.findUniqueOrThrow({ where: { id: ambiguous.id } });
  assert.equal(repaired.status, "MATCHED"); assert.equal(repaired.subjectId, a.subjectId); assert.equal(repaired.processingMode, "REPLAY");
  assert.equal((await db.funnelSubjectReference.findFirstOrThrow({ where: { sourceId: s.id, kind: "ENQUIRY", externalId: "b" } })).subjectId, b.subjectId);
});
