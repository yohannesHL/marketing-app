import test from "node:test";
import assert from "node:assert/strict";
import { createEmailFixture, EMAIL_FIXTURE_ORIGIN } from "../support/email-fixture";
import { createEmailApi } from "../../apps/web/src/server/email/emailApi";
import { pruneEmailEvidence } from "../../apps/web/src/server/email/emailRetention";
import { emailPayloadContext } from "../../apps/web/src/server/email/emailPolicy";

const req = (path: string, method = "GET", cookie?: string, body?: unknown, origin: string | null = EMAIL_FIXTURE_ORIGIN) => new Request(`${EMAIL_FIXTURE_ORIGIN}${path}`, {
  method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test("email management enforces a current session, exact Origin, owner isolation and private responses", async () => {
  const f = await createEmailFixture();
  try {
    const api = createEmailApi(f.auth, f.connections, f.campaigns, f.delivery), other = await f.owner();
    assert.equal((await api(req("/api/email/connections?environment=TEST"))).status, 401);
    for (const origin of [null, "https://foreign.example"]) assert.equal((await api(req("/api/email/connections", "POST", f.cookie, {}, origin))).status, 403);
    const setup = await f.readyConnection();
    const response = await api(req(`/api/email/connections/${setup.connection.id}`, "GET", other.cookie)); assert.equal(response.status, 404);
    const own = await api(req(`/api/email/connections/${setup.connection.id}`, "GET", f.cookie));
    assert.equal(own.status, 200); assert.equal(own.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(await own.text(), /credentialCiphertext|webhookSecret|fixture_|expectedWebhookUrlDigest|ingressTokenHash/);
    await f.db.customerSession.delete({ where: { id: f.principal.sessionId } });
    assert.equal((await api(req("/api/marketing-campaigns?environment=TEST", "GET", f.cookie))).status, 401);
  } finally { await f.close(); }
});

test("the owned HTTP path submits the pinned membership once and exposes safe delivery history", async () => {
  const f = await createEmailFixture();
  try {
    const api = createEmailApi(f.auth, f.connections, f.campaigns, f.delivery), enrolled = await f.enrolled();
    const path = `/api/email/memberships/${enrolled.membership.id}/dispatch`;
    const response = await api(req(path, "POST", f.cookie, {})); assert.equal(response.status, 200);
    const result = await response.json(); assert.equal(result.outcome, "ACCEPTED");
    const again = await api(req(path, "POST", f.cookie, {})); assert.equal((await again.json()).outcome, "ALREADY_ACCEPTED");
    assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
    const history = await api(req(`/api/email/sends/${result.send.id}`, "GET", f.cookie));
    assert.doesNotMatch(await history.text(), /payloadCiphertext|credentialCiphertext|idempotencyKey|maya@example|whsec_/);
    assert.equal((await api(req(path, "POST", f.cookie, { recipient: "intruder@example.test" }))).status, 400);
  } finally { await f.close(); }
});

test("unsubscribe GET only confirms; token POST works without session or Origin and works again after opt-in", async () => {
  const f = await createEmailFixture();
  try {
    const api = createEmailApi(f.auth, f.connections, f.campaigns, f.delivery), enrolled = await f.enrolled();
    const intent = await f.delivery.createIntent(f.principal, { membershipId: enrolled.membership.id });
    const send = await f.db.messageSend.findUniqueOrThrow({ where: { id: intent.send.id } });
    const payload = JSON.parse(f.vault.decrypt(send.payloadCiphertext!, emailPayloadContext(send)));
    const token = payload.headers["List-Unsubscribe"].match(/\/([A-Za-z0-9_-]{43})>/)[1];
    const path = `/unsubscribe/${token}`;
    const confirmation = await api(req(path)); assert.equal(confirmation.status, 200);
    assert.match(await confirmation.text(), /method="post"/);
    assert.equal((await f.campaigns.policy(f.principal, enrolled.contact.id, "consultation")).state, "OPTED_IN");
    const post = () => api(new Request(`${EMAIL_FIXTURE_ORIGIN}${path}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" }));
    assert.equal((await post()).status, 200); assert.equal((await post()).status, 200);
    assert.equal((await f.campaigns.policy(f.principal, enrolled.contact.id, "consultation")).state, "OPTED_OUT");
    assert.equal((await f.db.messageSend.findUniqueOrThrow({ where: { id: send.id } })).status, "CANCELLED");
    await f.consent(enrolled.contact.id); assert.equal((await post()).status, 200);
    assert.equal((await f.campaigns.policy(f.principal, enrolled.contact.id, "consultation")).state, "OPTED_OUT");
    assert.equal((await api(req(`/unsubscribe/${"z".repeat(43)}`))).status, 404);
    const tooLarge = new Request(`${EMAIL_FIXTURE_ORIGIN}${path}`, { method: "POST", body: "a".repeat(4097) });
    assert.equal((await api(tooLarge)).status, 413);
  } finally { await f.close(); }
});

test("signed HTTP webhook retains exact bytes, deduplicates, rejects changes and connects a trusted subject", async () => {
  const f = await createEmailFixture();
  try {
    const api = createEmailApi(f.auth, f.connections, f.campaigns, f.delivery), enrolled = await f.enrolled();
    const intent = await f.delivery.createIntent(f.principal, { membershipId: enrolled.membership.id }); await f.delivery.dispatch(f.principal, intent.send.id);
    const send = await f.db.messageSend.findUniqueOrThrow({ where: { id: intent.send.id } });
    const event = { type: "email.delivered", created_at: f.now().toISOString(), data: { email_id: send.providerMessageId,
      from: "Team <hello@example.test>", to: [enrolled.contact.email], subject: enrolled.step.subject, tags: { launchpad_send: send.id } } };
    const signed = f.signWebhook(event), url = enrolled.setup.webhookUrl;
    const hook = (raw = signed.rawBody, headers = signed.headers) => new Request(url, { method: "POST", headers: new Headers([...headers, ["Content-Type", "application/json"]]), body: raw });
    assert.equal((await api(hook())).status, 202); assert.equal((await api(hook())).status, 202);
    await f.delivery.processOnce();
    const tracked = await f.db.trackingEvent.findFirstOrThrow({ where: { sourceId: enrolled.setup.connection.sourceId } });
    assert.equal(tracked.subjectId, enrolled.subject.id); assert.equal(tracked.contactId, enrolled.contact.id);
    assert.equal(await f.delivery.processOnce(), null);
    const changed = f.signWebhook({ ...event, data: { ...event.data, subject: "Changed" } }, { deliveryId: signed.deliveryId });
    assert.equal((await api(hook(changed.rawBody, changed.headers))).status, 409);
    assert.equal((await api(hook(Buffer.from("{}")))).status, 401);
    assert.equal(await f.db.emailDeliveryReceipt.count(), 1);
  } finally { await f.close(); }
});

test("email HTTP input bounds reject oversized definitions and unsupported funnel automation", async () => {
  const f = await createEmailFixture();
  try {
    const api = createEmailApi(f.auth, f.connections, f.campaigns, f.delivery);
    assert.equal((await api(req("/api/marketing-campaigns", "POST", f.cookie, { name: "x".repeat(131073) }))).status, 413);
    const campaign = await f.campaigns.create(f.principal, { name: "External awareness", environment: "TEST", category: "SOCIAL" });
    const response = await api(req(`/api/marketing-campaigns/${campaign.id}/publish`, "POST", f.cookie, { draftRevision: 1 }));
    assert.equal(response.status, 409);
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test("email retention erases finished payloads and receipt PII but preserves unknown effects and policy tombstones", async () => {
  const f = await createEmailFixture();
  try {
    const accepted = await f.enrolled(), first = await f.delivery.createIntent(f.principal, { membershipId: accepted.membership.id });
    await f.delivery.dispatch(f.principal, first.send.id);
    const stored = await f.db.messageSend.findUniqueOrThrow({ where: { id: first.send.id } });
    const signed = f.signWebhook({ type: "email.delivered", created_at: f.now().toISOString(), data: { email_id: stored.providerMessageId,
      from: "Fixture team <hello@example.test>", subject: accepted.step.subject, to: [accepted.contact.email], tags: { launchpad_send: first.send.id } } });
    await f.delivery.ingestWebhook(new URL(accepted.setup.webhookUrl).pathname.split("/").at(-1)!, signed.headers, signed.rawBody);
    await f.delivery.processOnce();
    const person = await f.recipient({ email: "unknown@example.test" }), pending = await f.enrolled({ recipient: person });
    f.transport.onSend = () => { throw new Error("uncertain network"); };
    const second = await f.delivery.createIntent(f.principal, { membershipId: pending.membership.id });
    assert.equal((await f.delivery.dispatch(f.principal, second.send.id)).outcome, "UNKNOWN");
    const later = new Date(f.now().getTime() + 366 * 86400000);
    const result = await pruneEmailEvidence(f.db, later); assert.equal(result.sends, 1); assert.equal(result.receipts, 1);
    const erased = await f.db.messageSend.findUniqueOrThrow({ where: { id: first.send.id } });
    assert.equal(erased.payloadCiphertext, null); assert.equal(erased.providerMessageId, null); assert.ok(erased.providerMessageIdDigest);
    const receipt = await f.db.emailDeliveryReceipt.findFirstOrThrow(); assert.deepEqual(receipt.envelope, {}); assert.equal(receipt.addressDigest, null);
    const unknown = await f.db.messageSend.findUniqueOrThrow({ where: { id: second.send.id } }); assert.equal(unknown.status, "UNKNOWN"); assert.ok(unknown.payloadCiphertext);
    assert.equal((await pruneEmailEvidence(f.db, later)).sends, 0);
  } finally { await f.close(); }
});

test("retention preserves unprocessed negative policy evidence and its send until the receipt worker applies it", async () => {
  const f = await createEmailFixture();
  try {
    const enrolled = await f.enrolled(), intent = await f.delivery.createIntent(f.principal, { membershipId: enrolled.membership.id });
    await f.delivery.dispatch(f.principal, intent.send.id);
    const signed = f.signWebhook({ type: "suppression.added", created_at: f.now().toISOString(),
      data: { email: enrolled.contact.email, origin: "api", source_id: null } });
    await f.delivery.ingestWebhook(enrolled.setup.ingressToken, signed.headers, signed.rawBody);
    const later = new Date(f.now().getTime() + 366 * 86400000);
    const pruned = await pruneEmailEvidence(f.db, later);
    assert.equal(pruned.receipts, 0); assert.equal(pruned.sends, 0);
    assert.equal((await f.db.emailDeliveryReceipt.findFirstOrThrow()).status, "QUEUED");
    assert.ok((await f.db.messageSend.findUniqueOrThrow({ where: { id: intent.send.id } })).payloadCiphertext);
    await f.delivery.processOnce();
    assert.equal(await f.db.emailSuppression.count({ where: { active: true, reason: "PROVIDER_SUPPRESSION" } }), 1);
    const finished = await pruneEmailEvidence(f.db, later); assert.equal(finished.receipts, 1); assert.equal(finished.sends, 1);
    assert.equal(await f.db.emailSuppression.count({ where: { active: true, reason: "PROVIDER_SUPPRESSION" } }), 1);
  } finally { await f.close(); }
});
