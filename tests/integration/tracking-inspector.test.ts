import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createEmailFixture, EMAIL_FIXTURE_ORIGIN } from "../support/email-fixture";
import { createTrackingApi } from "../../apps/web/src/server/funnels/trackingApi";
import type { Prisma } from "../../apps/web/src/generated/prisma/client";

const request = (path: string, cookie?: string, method = "GET", body?: unknown, origin?: string) => new Request(`${EMAIL_FIXTURE_ORIGIN}${path}`, {
  method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test("source diagnostics enforce owner, environment and session and disclose no connection credentials", async () => {
  const f = await createEmailFixture();
  try {
    const api = createTrackingApi(f.auth, f.tracking), other = await f.owner(), recipient = await f.recipient();
    const path = `/api/tracking/sources/${recipient.source.id}?environment=TEST`;
    assert.equal((await api(request(path))).status, 401);
    assert.equal((await api(request(path, other.cookie))).status, 404);
    assert.equal((await api(request(path.replace("TEST", "LIVE"), f.cookie))).status, 404);
    assert.equal((await api(request(path.replace("TEST", "STAGING"), f.cookie))).status, 400);
    const response = await api(request(path, f.cookie));
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    const source = await response.json();
    assert.equal(source.id, recipient.source.id); assert.equal(source.health.matchedEvents, 1);
    assert.equal(source.health.lastReceipt.id, recipient.event.id); assert.equal(source.health.lastReceipt.subjectId, recipient.subject.id);
    assert.equal(source.health.readyForAutomation, false);
    assert.doesNotMatch(JSON.stringify(source), /credentialCiphertext|signingSecret|apiToken|ingressTokenHash|maya@example|email-fixture-api-signing-secret|contactIdentity/);
    const liveSource = await f.db.trackingSource.create({ data: { ownerId: f.principal.userId, environment: "LIVE", provider: "API", name: "Live configured", externalAccountId: randomUUID(), config: {}, ingressTokenHash: randomUUID() } });
    const list = await api(request("/api/tracking/sources?environment=TEST", f.cookie));
    assert.deepEqual((await list.json()).map((s: { id: string }) => s.id), [recipient.source.id]);
    assert.equal((await api(request(`/api/tracking/sources/${liveSource.id}?environment=LIVE`, f.cookie))).status, 200);
    await f.db.customerSession.delete({ where: { id: f.principal.sessionId } });
    assert.equal((await api(request(path, f.cookie))).status, 401);
  } finally { await f.close(); }
});

test("newest inbox uses received time with stable tied cursors, source isolation and exact receipt lookup", async () => {
  const f = await createEmailFixture();
  try {
    const api = createTrackingApi(f.auth, f.tracking), recipient = await f.recipient(), other = await f.recipient({ principal: (await f.owner()).principal });
    const receivedAt = new Date("2026-10-20T10:00:00Z");
    const data: Prisma.TrackingEventCreateManyInput[] = Array.from({ length: 55 }, (_, i) => ({
      id: `inbox-${String(i).padStart(3, "0")}`, ownerId: f.principal.userId, environment: "TEST", sourceId: recipient.source.id,
      sourceGeneration: 1, type: "custom.qualified", dedupeKey: `inbox-${i}`, rawPayloadDigest: "fixture-digest", status: "UNMATCHED",
      envelope: { resource: { kind: "DEAL", id: `deal-${i}` }, subjectKind: "SALES", authority: "SERVER_ASSERTED", verification: "SERVER_HMAC", references: [], properties: { score: i }, contact: { email: "never-show-this@example.test" }, correlationEmail: "correlation-private@example.test" },
      occurredAt: new Date("2026-10-18T10:00:00Z"), receivedAt, expiresAt: new Date("2027-01-01T00:00:00Z"),
    }));
    await f.db.trackingEvent.createMany({ data });
    const base = `/api/tracking/sources/${recipient.source.id}/events`;
    const firstResponse = await api(request(`${base}?environment=TEST&order=newest`, f.cookie));
    assert.equal(firstResponse.status, 200); assert.equal(firstResponse.headers.get("cache-control"), "no-store");
    const first = await firstResponse.json(); assert.equal(first.events.length, 50); assert.equal(first.events[0].id, "inbox-054"); assert.equal(first.nextCursor, "inbox-005");
    assert.equal(first.events[0].evidence.subjectKind, "SALES"); assert.equal(first.events[0].evidence.properties.score, 54);
    assert.doesNotMatch(JSON.stringify(first), /never-show-this|correlation-private|rawPayloadDigest|contactIdentity|ownerId|credentialCiphertext/);
    const second = await (await api(request(`${base}?order=newest&cursor=${first.nextCursor}`, f.cookie))).json();
    assert.equal(second.events.length, 6); assert.equal(second.nextCursor, null);
    const ids = [...first.events, ...second.events].map((event: { id: string }) => event.id);
    assert.equal(new Set(ids).size, 56); assert.equal(ids.at(-1), recipient.event.id);
    const legacy = await (await api(request(base, f.cookie))).json();
    assert.equal(legacy.events[0].id, [...ids].sort()[0], "default remains legacy ID ascending order");
    const exact = await (await api(request(`${base}?order=newest&eventId=inbox-001`, f.cookie))).json();
    assert.deepEqual(exact.events.map((e: { id: string }) => e.id), ["inbox-001"]); assert.equal(exact.nextCursor, null);
    for (const query of [`cursor=${other.event.id}`, `eventId=${other.event.id}`, "environment=LIVE", "cursor=missing-receipt"]) assert.equal((await api(request(`${base}?${query}`, f.cookie))).status, 404);
    for (const query of ["order=garbage", "cursor=inbox-001&eventId=inbox-002"]) assert.equal((await api(request(`${base}?${query}`, f.cookie))).status, 400);
    const source = await (await api(request(`/api/tracking/sources/${recipient.source.id}`, f.cookie))).json();
    assert.equal(source.health.lastReceipt.id, "inbox-054"); assert.equal(source.health.unresolvedEvents, 55);
  } finally { await f.close(); }
});

test("inbox redaction never reveals erased payloads, and read diagnostics never create provider traffic", async () => {
  const f = await createEmailFixture();
  try {
    const recipient = await f.recipient(), api = createTrackingApi(f.auth, f.tracking);
    await f.tracking.deleteContact(f.principal, recipient.contact.id);
    const page = await (await api(request(`/api/tracking/sources/${recipient.source.id}/events?eventId=${recipient.event.id}`, f.cookie))).json();
    assert.equal(page.events[0].status, "REDACTED"); assert.equal(page.events[0].evidence, null);
    assert.doesNotMatch(JSON.stringify(page), /maya@example|CRM_CONTACT/);
    const connection = await f.readyConnection(); f.requests.length = 0;
    const source = await (await api(request(`/api/tracking/sources/${connection.connection.sourceId}`, f.cookie))).json();
    assert.equal(source.provider, "RESEND"); assert.equal(source.credentialsManagedBy, "EMAIL_CONNECTION");
    assert.equal(source.credentialsSaved, undefined); assert.equal(f.requests.length, 0);
    assert.doesNotMatch(JSON.stringify(source), /fixture_|whsec_|providerWebhookId|expectedWebhookUrlDigest|credentialCiphertext/);
  } finally { await f.close(); }
});

test("contact picker paginates owned live identities, filters bounded names and emails and withholds deleted records", async () => {
  const f = await createEmailFixture();
  try {
    const api = createTrackingApi(f.auth, f.tracking), other = await f.owner();
    await f.db.funnelContact.createMany({ data: Array.from({ length: 54 }, (_, i) => ({ id: `picker-${String(i).padStart(3, "0")}`, ownerId: f.principal.userId, environment: "TEST", name: `Customer ${i}`, email: `customer${i}@example.test` })) });
    const deleted = await f.db.funnelContact.create({ data: { ownerId: f.principal.userId, environment: "TEST", name: "Deleted private name", email: "deleted-private@example.test", deletedAt: f.now() } });
    const live = await f.db.funnelContact.create({ data: { ownerId: f.principal.userId, environment: "LIVE", email: "live-private@example.test" } });
    const foreign = await f.db.funnelContact.create({ data: { ownerId: other.principal.userId, environment: "TEST", email: "foreign-private@example.test" } });
    assert.equal((await api(request("/api/tracking/contacts?environment=TEST"))).status, 401);
    const firstResponse = await api(request("/api/tracking/contacts?environment=TEST&query=", f.cookie));
    assert.equal(firstResponse.status, 200); assert.equal(firstResponse.headers.get("cache-control"), "no-store");
    const first = await firstResponse.json(); assert.equal(first.contacts.length, 50); assert.equal(first.nextCursor, "picker-049");
    assert.deepEqual(Object.keys(first.contacts[0]).sort(), ["createdAt", "email", "environment", "id", "name"]);
    const second = await (await api(request(`/api/tracking/contacts?environment=TEST&cursor=${first.nextCursor}`, f.cookie))).json();
    assert.equal(second.contacts.length, 4); assert.equal(second.nextCursor, null);
    assert.equal(new Set([...first.contacts, ...second.contacts].map(c => c.id)).size, 54);
    assert.doesNotMatch(JSON.stringify([first, second]), /deleted-private|foreign-private|live-private|ownerId|deletedAt/);
    for (const query of ["Customer%2053", "customer53%40example.test"]) {
      const found = await (await api(request(`/api/tracking/contacts?environment=TEST&query=${query}`, f.cookie))).json();
      assert.deepEqual(found.contacts.map((c: { id: string }) => c.id), ["picker-053"]);
    }
    for (const cursor of [deleted.id, live.id, foreign.id]) assert.equal((await api(request(`/api/tracking/contacts?environment=TEST&cursor=${cursor}`, f.cookie))).status, 404);
    assert.equal((await api(request("/api/tracking/contacts?environment=TEST&query=Customer%2053&cursor=picker-000", f.cookie))).status, 404);
    for (const path of ["/api/tracking/contacts", "/api/tracking/contacts?environment=other", `/api/tracking/contacts?environment=TEST&query=${"x".repeat(101)}`, "/api/tracking/contacts?environment=TEST&query=%00"]) assert.equal((await api(request(path, f.cookie))).status, 400);
  } finally { await f.close(); }
});

test("subject picker keeps subject identity separate and hides deleted contact data", async () => {
  const f = await createEmailFixture();
  try {
    const api = createTrackingApi(f.auth, f.tracking), contactExternalId = randomUUID();
    const first = await f.recipient({ contactExternalId }), second = await f.recipient({ contactExternalId });
    assert.equal(first.contact.id, second.contact.id); assert.notEqual(first.subject.id, second.subject.id);
    await f.db.funnelContact.update({ where: { id: first.contact.id }, data: { name: "Maya" } });
    const own = await (await api(request("/api/tracking/subjects?environment=TEST", f.cookie))).json();
    assert.ok(Array.isArray(own)); assert.equal(own.length, 2);
    assert.deepEqual(own[0].contact, { id: first.contact.id, name: "Maya", email: first.contact.email });
    assert.deepEqual(new Set(own.map((s: { id: string }) => s.id)), new Set([first.subject.id, second.subject.id]));
    // The read boundary withholds contact PII even if a legacy tombstone still holds it.
    await f.db.funnelContact.update({ where: { id: first.contact.id }, data: { deletedAt: f.now() } });
    const after = await (await api(request("/api/tracking/subjects?environment=TEST", f.cookie))).json();
    assert.ok(after.every((s: { contact: unknown }) => s.contact === null)); assert.doesNotMatch(JSON.stringify(after), /Maya|maya@example/);
    const foreign = await f.owner(); assert.deepEqual(await (await api(request("/api/tracking/subjects?environment=TEST", foreign.cookie))).json(), []);
  } finally { await f.close(); }
});

test("inspector recovery mutations keep session and exact-Origin checks and cannot manage email source credentials", async () => {
  const f = await createEmailFixture();
  try {
    const api = createTrackingApi(f.auth, f.tracking), recipient = await f.recipient(), other = await f.owner();
    const path = `/api/tracking/sources/${recipient.source.id}/events/${recipient.event.id}/replay`;
    assert.equal((await api(request(path, f.cookie, "POST", {}))).status, 403);
    assert.equal((await api(request(path, f.cookie, "POST", {}, "https://foreign.example"))).status, 403);
    assert.equal((await api(request(path, other.cookie, "POST", {}, EMAIL_FIXTURE_ORIGIN))).status, 404);
    const managed = await f.readyConnection();
    const response = await api(request(`/api/tracking/sources/${managed.connection.sourceId}`, f.cookie, "PATCH", { status: "PAUSED" }, EMAIL_FIXTURE_ORIGIN));
    assert.equal(response.status, 409); assert.equal((await response.json()).code, "MANAGED_EMAIL_SOURCE");
    const result = await api(request(path, f.cookie, "POST", {}, EMAIL_FIXTURE_ORIGIN));
    assert.equal(result.status, 202);
    const queued = await f.db.trackingEvent.findUniqueOrThrow({ where: { id: recipient.event.id } });
    assert.equal(queued.processingMode, "REPLAY"); assert.equal(queued.sourceGeneration, recipient.event.sourceGeneration);
  } finally { await f.close(); }
});
