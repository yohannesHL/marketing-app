import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const migrationRoot = "apps/web/prisma/migrations", migrationName = "20261017020000_funnel_email";
const now = "2026-10-17T12:00:00.000Z", later = "2026-10-18T12:00:00.000Z";
type Values = Record<string, string | number | null>;
function insert(db: DatabaseSync, table: string, values: Values) {
  const keys = Object.keys(values);
  db.prepare(`INSERT INTO "${table}" (${keys.map(key => `"${key}"`).join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(values));
}
async function legacy() {
  const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON");
  db.exec(await readFile("tests/fixtures/legacy-account-schema.sql", "utf8"));
  for (const name of (await readdir(migrationRoot)).sort())
    if (name >= "20261013000000_customer_connections" && name < migrationName && /^\d{14}_/.test(name))
      db.exec(await readFile(`${migrationRoot}/${name}/migration.sql`, "utf8"));
  return db;
}
async function migrate(db: DatabaseSync) {
  db.exec(await readFile(`${migrationRoot}/${migrationName}/migration.sql`, "utf8"));
  assert.equal(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
}
function fixture(db: DatabaseSync, suffix: string, ownerId = "owner-a", environment = "TEST", scopeKind = "SUBJECT") {
  db.prepare('INSERT OR IGNORE INTO "User" ("id","name") VALUES (?,?)').run(ownerId, ownerId);
  const scope = { ownerId, environment }, sourceId = `source-${suffix}`, connectionId = `connection-${suffix}`, senderId = `sender-${suffix}`;
  const campaignId = `campaign-${suffix}`, revisionId = `revision-${suffix}`, stepId = `step-${suffix}`, contactId = `contact-${suffix}`, subjectId = `subject-${suffix}`;
  insert(db, "TrackingSource", { id: sourceId, ...scope, provider: "RESEND", externalAccountId: suffix, name: "Email", config: "{}", ingressTokenHash: `ingress-${suffix}`, updatedAt: now });
  insert(db, "EmailConnection", { id: connectionId, ...scope, sourceId, credentialCiphertext: "vaulted", capabilities: "{}", readiness: "{}", updatedAt: now });
  insert(db, "EmailSender", { id: senderId, ...scope, connectionId, address: "sender@example.test", readiness: "{}", updatedAt: now });
  insert(db, "FunnelContact", { id: contactId, ...scope, email: "recipient@example.test" });
  insert(db, "FunnelSubject", { id: subjectId, ...scope, kind: "SALES", contactId });
  insert(db, "MarketingCampaign", { id: campaignId, ...scope, name: "Campaign", membershipScope: scopeKind, draft: "{}", updatedAt: now });
  insert(db, "CampaignRevision", { id: revisionId, ...scope, campaignId, number: 1, definition: "{}", digest: `definition-${suffix}`, senderId, subscriptionCategory: "newsletter", sendWindow: "{}", publishedAt: now });
  insert(db, "CampaignStep", { id: stepId, ...scope, revisionId, key: "welcome", position: 0, subject: "Welcome", text: "Reviewed body" });
  return { scope, sourceId, connectionId, senderId, campaignId, revisionId, stepId, contactId, subjectId, scopeKind, addressDigest: `address-${suffix}` };
}
function membership(db: DatabaseSync, suffix: string, f: ReturnType<typeof fixture>, extra: Values = {}) {
  const values = { id: `membership-${suffix}`, ...f.scope, campaignId: f.campaignId, revisionId: f.revisionId, contactId: f.contactId, addressDigest: f.addressDigest,
    scopeKind: f.scopeKind, scopeKey: `${f.scopeKind}:${f.scopeKind === "SUBJECT" ? f.subjectId : f.contactId}`, subjectId: f.scopeKind === "SUBJECT" ? f.subjectId : null, ...extra };
  insert(db, "CampaignMembership", values); return values;
}
function reason(db: DatabaseSync, suffix: string, f: ReturnType<typeof fixture>, membershipId: string, extra: Values = {}) {
  const values = { id: `reason-${suffix}`, ...f.scope, membershipId, campaignId: f.campaignId, requestedRevisionId: f.revisionId, kind: "MANUAL", actorId: f.scope.ownerId,
    requestKey: `enrol-${suffix}`, requestDigest: `command-${suffix}`, note: "Private context", ...extra };
  insert(db, "CampaignMembershipReason", values); return values;
}
function send(db: DatabaseSync, suffix: string, f: ReturnType<typeof fixture>, membershipId: string, extra: Values = {}) {
  const values = { id: `send-${suffix}`, ...f.scope, membershipId, revisionId: f.revisionId, stepId: f.stepId, connectionId: f.connectionId, senderId: f.senderId,
    contactId: f.contactId, recipientDigest: f.addressDigest, subscriptionCategory: "newsletter", payloadCiphertext: "vaulted-request", requestDigest: `request-${suffix}`,
    idempotencyKey: `key-${suffix}`, dueAt: now, expiresAt: later, connectionGeneration: 1, membershipRevision: 1, updatedAt: now, ...extra };
  insert(db, "MessageSend", values); return values;
}
function receipt(db: DatabaseSync, suffix: string, f: ReturnType<typeof fixture>, extra: Values = {}) {
  const values = { id: `receipt-${suffix}`, ...f.scope, connectionId: f.connectionId, connectionGeneration: 1, providerDeliveryId: `delivery-${suffix}`, type: "email.delivered",
    rawPayloadDigest: `receipt-digest-${suffix}`, envelope: '{"status":"delivered"}', providerMessageId: `provider-${suffix}`, providerMessageIdDigest: `provider-digest-${suffix}`,
    addressDigest: f.addressDigest, opaqueSendRef: `ref-${suffix}`, verificationKeyVersion: 1, occurredAt: now, expiresAt: later, ...extra };
  insert(db, "EmailDeliveryReceipt", values); return values;
}
function journey(db: DatabaseSync, suffix: string, scope: { ownerId: string; environment: string }, subjectId: string) {
  const funnelId = `funnel-${suffix}`, versionId = `version-${suffix}`, journeyId = `journey-${suffix}`, transitionId = `transition-${suffix}`;
  insert(db, "Funnel", { id: funnelId, ...scope, name: "Funnel", subjectKind: "SALES", draft: "{}", updatedAt: now });
  insert(db, "FunnelVersion", { id: versionId, ...scope, funnelId, number: 1, definition: "{}", digest: `funnel-digest-${suffix}`, publishedAt: now });
  insert(db, "FunnelStage", { id: `stage-${suffix}`, ...scope, versionId, key: "welcome", name: "Welcome" });
  insert(db, "FunnelJourney", { id: journeyId, ...scope, funnelId, versionId, subjectId, currentStageKey: "welcome" });
  insert(db, "FunnelStageTransition", { id: transitionId, ...scope, journeyId, versionId, sequence: 1, toStageKey: "welcome", triggerKind: "MANUAL", mode: "LIVE", reasonCode: "MANUAL_ENTRY", evaluationTrace: "{}", occurredAt: now });
  return { journeyId, transitionId, versionId, stageKey: "welcome" };
}

test("email migration retains source data, child foreign keys, old triggers and paid-only legacy categories", async () => {
  const db = await legacy();
  try {
    insert(db, "User", { id: "owner-a", name: "Owner" });
    for (const provider of ["NATIVE", "API", "CALENDLY", "SHOPIFY"])
      insert(db, "TrackingSource", { id: provider, ownerId: "owner-a", environment: "LIVE", provider, externalAccountId: provider, name: provider, config: "{}", credentialCiphertext: "old-vault", ingressTokenHash: provider, generation: 7, updatedAt: now });
    insert(db, "FunnelSubject", { id: "subject-old", ownerId: "owner-a", environment: "LIVE", kind: "SALES" });
    insert(db, "TrackingEvent", { id: "event-old", ownerId: "owner-a", environment: "LIVE", sourceId: "API", sourceGeneration: 7, type: "enquiry.accepted", dedupeKey: "old-key", rawPayloadDigest: "old-digest", envelope: "{}", status: "MATCHED", subjectId: "subject-old", matchRevision: 1, occurredAt: now, expiresAt: later });
    insert(db, "FunnelEvaluationReceipt", { id: "receipt-old", ownerId: "owner-a", environment: "LIVE", eventId: "event-old", subjectId: "subject-old", matchRevision: 1, mode: "BACKFILL" });
    journey(db, "old", { ownerId: "owner-a", environment: "LIVE" }, "subject-old");
    const previous = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table','index','trigger')").all();
    await migrate(db);
    for (const row of previous) {
      if (row.name === "TrackingSource") continue;
      assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE type=? AND name=?").get(row.type, row.name)?.sql, row.sql, `${row.name} changed`);
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "TrackingSource" WHERE "generation"=7 AND "credentialCiphertext"=\'old-vault\'').get()?.n, 4);
    assert.equal(db.prepare('SELECT "sourceGeneration" FROM "TrackingEvent" WHERE "id"=\'event-old\'').get()?.sourceGeneration, 7);
    assert.equal(db.prepare('SELECT "mode" FROM "FunnelEvaluationReceipt" WHERE "id"=\'receipt-old\'').get()?.mode, "BACKFILL");
    assert.equal(db.prepare('SELECT "currentStageKey" FROM "FunnelJourney" WHERE "id"=\'journey-old\'').get()?.currentStageKey, "welcome");
    assert.ok(db.prepare('PRAGMA foreign_key_list("TrackingEvent")').all().some(row => row.table === "TrackingSource"));
    assert.throws(() => db.exec('UPDATE "TrackingSource" SET "provider"=\'RESEND\' WHERE "id"=\'API\''), /immutable/);
    assert.throws(() => insert(db, "Campaign", { id: "legacy-email", name: "Invalid", objective: "LEADS", status: "DRAFT", budget: "{}", targeting: "{}", category: "EMAIL_MARKETING" }), /CHECK/);
    fixture(db, "managed");
    assert.throws(() => db.exec('UPDATE "TrackingSource" SET "credentialCiphertext"=\'duplicate-secret\' WHERE "id"=\'source-managed\''), /CHECK/);
  } finally { db.close(); }
});

test("two stage associations retain separate journey reasons for one stable campaign membership", async () => {
  const db = await legacy();
  try {
    await migrate(db); const f = fixture(db, "stages"), m = membership(db, "stages", f);
    const first = journey(db, "first", f.scope, f.subjectId), second = journey(db, "second", f.scope, f.subjectId);
    for (const [suffix, origin] of [["first", first], ["second", second]] as const) {
      const linkId = `link-${suffix}`;
      insert(db, "StageCampaignLink", { id: linkId, ...f.scope, versionId: origin.versionId, stageKey: origin.stageKey, key: "report-only", campaignId: f.campaignId });
      reason(db, suffix, f, m.id, { kind: "STAGE", ...origin, linkId });
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "CampaignMembership"').get()?.n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "CampaignMembershipReason"').get()?.n, 2);
    assert.throws(() => reason(db, "cross-context", f, m.id, { kind: "STAGE", ...first, linkId: "link-second" }), /FOREIGN KEY/);
    assert.throws(() => db.exec('UPDATE "StageCampaignLink" SET "purpose"=\'ATTRIBUTION\''), /immutable/);
    db.prepare('UPDATE "CampaignMembershipReason" SET "endedAt"=?,"endReason"=\'STAGE_EXIT\' WHERE "id"=\'reason-first\'').run(now);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "CampaignMembershipReason" WHERE "endedAt" IS NULL').get()?.n, 1);
    assert.throws(() => db.exec('UPDATE "CampaignMembershipReason" SET "endedAt"=NULL WHERE "id"=\'reason-first\''), /immutable/);
  } finally { db.close(); }
});

test("policy command tombstones retain provenance and credentials cannot rotate without a version", async () => {
  const db = await legacy();
  try {
    await migrate(db); const f = fixture(db, "audit"), r = receipt(db, "audit", f);
    const audit = { id: "audit", ...f.scope, addressDigest: f.addressDigest, category: "newsletter", action: "OPT_OUT", reason: "User request", requestKey: "opt-out-command", requestDigest: "digest", sourceId: f.sourceId, receiptId: r.id, provenance: '{"private":"context"}' };
    insert(db, "EmailPolicyAudit", audit);
    assert.throws(() => insert(db, "EmailPolicyAudit", { ...audit, id: "repeated" }), /UNIQUE/);
    assert.throws(() => db.exec('UPDATE "EmailPolicyAudit" SET "action"=\'OPT_IN\''), /immutable/);
    assert.throws(() => db.exec('UPDATE "EmailPolicyAudit" SET "provenance"=\'{}\''), /redaction/);
    db.prepare('UPDATE "EmailPolicyAudit" SET "reason"=\'REDACTED\',"provenance"=\'{}\',"redactedAt"=?').run(now);
    assert.throws(() => insert(db, "EmailPolicyAudit", { ...audit, id: "replayed-after-redaction" }), /UNIQUE/);
    assert.throws(() => db.exec('UPDATE "EmailConnection" SET "credentialCiphertext"=\'replacement\''), /version/);
    db.exec('UPDATE "EmailConnection" SET "credentialCiphertext"=\'replacement\',"credentialVersion"=2');
    assert.throws(() => db.exec('UPDATE "EmailConnection" SET "credentialVersion"=1'), /version/);
  } finally { db.close(); }
});

test("email relationships reject cross-owner, cross-environment and non-managed provider bindings", async () => {
  const db = await legacy();
  try {
    await migrate(db); const a = fixture(db, "a"), b = fixture(db, "b", "owner-b"), live = fixture(db, "live", "owner-a", "LIVE");
    for (const other of [b, live]) {
      assert.throws(() => insert(db, "EmailSender", { id: `bad-${other.senderId}`, ...a.scope, connectionId: other.connectionId, address: "sender@example.test", readiness: "{}", updatedAt: now }), /FOREIGN KEY/);
      assert.throws(() => membership(db, `bad-${other.campaignId}`, { ...a, campaignId: other.campaignId, revisionId: other.revisionId }), /FOREIGN KEY/);
    }
    insert(db, "TrackingSource", { id: "api-source", ...a.scope, provider: "API", externalAccountId: "api", name: "API", config: "{}", ingressTokenHash: "api", updatedAt: now });
    assert.throws(() => insert(db, "EmailConnection", { id: "wrong-provider", ...a.scope, sourceId: "api-source", credentialCiphertext: "vaulted", capabilities: "{}", readiness: "{}", updatedAt: now }), /FOREIGN KEY/);
    assert.throws(() => membership(db, "mismatch", a, { contactId: b.contactId }), /must match/);
    assert.throws(() => membership(db, "wrong-key", a, { scopeKey: "SUBJECT:another" }), /CHECK/);
    assert.throws(() => membership(db, "wrong-scope", a, { scopeKind: "CONTACT", subjectId: null, scopeKey: `CONTACT:${a.contactId}` }), /FOREIGN KEY/);
    const m = membership(db, "a", a);
    assert.throws(() => send(db, "wrong-recipient", a, m.id, { recipientDigest: "other-address" }), /FOREIGN KEY/);
    assert.throws(() => send(db, "wrong-step", a, m.id, { stepId: b.stepId }), /FOREIGN KEY/);
    assert.throws(() => send(db, "wrong-sender", a, m.id, { senderId: live.senderId }), /FOREIGN KEY/);
  } finally { db.close(); }
});

test("stable campaign membership pins revision and holds its slot across STOPPED unknown acceptance", async () => {
  const db = await legacy();
  try {
    await migrate(db); const f = fixture(db, "slot"), m = membership(db, "slot", f);
    insert(db, "CampaignRevision", { id: "revision-next", ...f.scope, campaignId: f.campaignId, number: 2, definition: "{}", digest: "next", senderId: f.senderId, subscriptionCategory: "newsletter", sendWindow: "{}", publishedAt: now });
    reason(db, "first", f, m.id); reason(db, "newer", f, m.id, { requestedRevisionId: "revision-next" });
    assert.throws(() => membership(db, "parallel", f, { cycle: 2, revisionId: "revision-next" }), /UNIQUE/);
    assert.throws(() => db.exec('UPDATE "CampaignMembership" SET "revisionId"=\'revision-next\''), /immutable/);
    const s = send(db, "unknown", f, m.id, { status: "UNKNOWN", firstSubmittedAt: now, idempotencyExpiresAt: later });
    db.prepare('UPDATE "CampaignMembership" SET "status"=\'STOPPED\',"stoppedAt"=? WHERE "id"=?').run(now, m.id);
    assert.throws(() => db.prepare('UPDATE "CampaignMembership" SET "endedAt"=? WHERE "id"=?').run(now, m.id), /Unresolved/);
    assert.throws(() => membership(db, "bypass-unknown", f, { cycle: 2 }), /UNIQUE/);
    db.prepare('UPDATE "MessageSend" SET "status"=\'ACCEPTED\',"acceptedAt"=?,"providerMessageId"=\'known\',"providerMessageIdDigest"=\'known-digest\' WHERE "id"=?').run(now, s.id);
    db.prepare('UPDATE "CampaignMembership" SET "endedAt"=? WHERE "id"=?').run(now, m.id);
    const next = membership(db, "explicit-next", f, { cycle: 2, revisionId: "revision-next" });
    assert.equal(next.revisionId, "revision-next");
    assert.throws(() => db.prepare('UPDATE "CampaignMembership" SET "status"=\'ACTIVE\',"endedAt"=NULL WHERE "id"=?').run(m.id), /reactivate/);
  } finally { db.close(); }
});

test("published content, send intent, unsubscribe binding and command/attribution identities are immutable", async () => {
  const db = await legacy();
  try {
    await migrate(db); const f = fixture(db, "immutable"), m = membership(db, "immutable", f), r = reason(db, "immutable", f, m.id), s = send(db, "immutable", f, m.id);
    db.prepare('UPDATE "MarketingCampaign" SET "publishedRevisionId"=? WHERE "id"=?').run(f.revisionId, f.campaignId);
    for (const [table, field, value] of [["CampaignRevision", "definition", "{}"], ["CampaignStep", "text", "Changed"], ["EmailSender", "address", "changed@example.test"]])
      assert.throws(() => db.prepare(`UPDATE "${table}" SET "${field}"=?`).run(value), /immutable/);
    assert.throws(() => db.prepare('UPDATE "MessageSend" SET "payloadCiphertext"=\'changed\' WHERE "id"=?').run(s.id), /redaction/);
    assert.throws(() => send(db, "duplicate", f, m.id), /UNIQUE/);
    assert.throws(() => reason(db, "duplicate", f, m.id, { requestKey: r.requestKey }), /UNIQUE/);
    const attribution = { id: "attribution", ...f.scope, sendId: s.id, membershipId: m.id, reasonId: r.id };
    insert(db, "MessageSendAttribution", attribution);
    assert.throws(() => insert(db, "MessageSendAttribution", { ...attribution, id: "attribution-again" }), /UNIQUE/);
    assert.throws(() => db.exec('UPDATE "MessageSendAttribution" SET "reasonId"=\'other\''), /immutable/);
    insert(db, "EmailUnsubscribeToken", { id: "token", ...f.scope, tokenHash: "opaque-hash", sendId: s.id, addressDigest: f.addressDigest, category: "newsletter" });
    assert.throws(() => insert(db, "EmailUnsubscribeToken", { id: "wrong-token", ...f.scope, tokenHash: "other-hash", sendId: s.id, addressDigest: "other-address", category: "newsletter" }), /FOREIGN KEY/);
    assert.throws(() => db.exec('UPDATE "EmailUnsubscribeToken" SET "category"=\'other\''), /immutable/);
  } finally { db.close(); }
});

test("delivery evidence deduplicates callbacks, binds once and permits only irreversible privacy redaction", async () => {
  const db = await legacy();
  try {
    await migrate(db); const f = fixture(db, "evidence"), m = membership(db, "evidence", f), s = send(db, "evidence", f, m.id), r = receipt(db, "evidence", f);
    assert.throws(() => receipt(db, "duplicate", f, { providerDeliveryId: r.providerDeliveryId }), /UNIQUE/);
    db.prepare('UPDATE "EmailDeliveryReceipt" SET "sendId"=?,"status"=\'MATCHED\',"processedAt"=? WHERE "id"=?').run(s.id, now, r.id);
    assert.throws(() => db.prepare('UPDATE "EmailDeliveryReceipt" SET "sendId"=NULL WHERE "id"=?').run(r.id), /rebound/);
    assert.throws(() => db.prepare('UPDATE "EmailDeliveryReceipt" SET "envelope"=\'{}\' WHERE "id"=?').run(r.id), /redaction/);
    insert(db, "DeliveryAttempt", { id: "attempt", ...f.scope, sendId: s.id, number: 1, connectionGeneration: 1, credentialVersion: 1, membershipRevision: 1, sendRevision: 1, startedAt: now });
    db.exec(`UPDATE "DeliveryAttempt" SET "outcome"='UNKNOWN',"completedAt"='${now}',"errorCode"='TIMEOUT'`);
    assert.throws(() => db.exec('UPDATE "DeliveryAttempt" SET "outcome"=\'ACCEPTED\''), /immutable/);
    db.prepare('UPDATE "MessageSend" SET "status"=\'UNKNOWN\',"firstSubmittedAt"=?,"idempotencyExpiresAt"=? WHERE "id"=?').run(now, later, s.id);
    assert.throws(() => db.prepare('UPDATE "MessageSend" SET "connectionGeneration"=2 WHERE "id"=?').run(s.id), /snapshots/);
    db.prepare('UPDATE "MessageSend" SET "payloadCiphertext"=NULL,"providerMessageId"=NULL,"redactedAt"=? WHERE "id"=?').run(now, s.id);
    db.prepare('UPDATE "EmailDeliveryReceipt" SET "status"=\'REDACTED\',"envelope"=\'{}\',"providerMessageId"=NULL,"addressDigest"=NULL,"opaqueSendRef"=NULL WHERE "id"=?').run(r.id);
    assert.throws(() => db.prepare('UPDATE "EmailDeliveryReceipt" SET "status"=\'QUEUED\' WHERE "id"=?').run(r.id), /replay/);
    assert.throws(() => db.prepare('UPDATE "MessageSend" SET "payloadCiphertext"=\'restored\',"redactedAt"=NULL WHERE "id"=?').run(s.id), /redaction/);
    assert.equal(db.prepare('SELECT "providerMessageIdDigest" FROM "EmailDeliveryReceipt" WHERE "id"=?').get(r.id)?.providerMessageIdDigest, r.providerMessageIdDigest);
    assert.throws(() => db.prepare('DELETE FROM "MessageSend" WHERE "id"=?').run(s.id), /retained/);
  } finally { db.close(); }
});

test("a definitely rejected intent can refresh permission fences but unknown attempts permanently exclude that retry", async () => {
  const db = await legacy();
  try {
    await migrate(db); const f = fixture(db, "retry"), m = membership(db, "retry", f), s = send(db, "retry", f, m.id, { status: "FAILED", firstSubmittedAt: now, idempotencyExpiresAt: later });
    insert(db, "DeliveryAttempt", { id: "rejected-attempt", ...f.scope, sendId: s.id, number: 1, connectionGeneration: 1, credentialVersion: 1, membershipRevision: 1, sendRevision: 1, startedAt: now, completedAt: now, outcome: "REJECTED" });
    db.prepare('UPDATE "MessageSend" SET "connectionGeneration"=2,"membershipRevision"=2 WHERE "id"=?').run(s.id);
    assert.equal(db.prepare('SELECT "membershipRevision" FROM "MessageSend" WHERE "id"=?').get(s.id)?.membershipRevision, 2);
    insert(db, "DeliveryAttempt", { id: "unknown-attempt", ...f.scope, sendId: s.id, number: 2, connectionGeneration: 2, credentialVersion: 1, membershipRevision: 2, sendRevision: 2, startedAt: now, completedAt: now, outcome: "UNKNOWN" });
    assert.throws(() => db.prepare('UPDATE "MessageSend" SET "membershipRevision"=3 WHERE "id"=?').run(s.id), /snapshots/);
    assert.equal(db.prepare('SELECT "idempotencyKey" FROM "MessageSend" WHERE "id"=?').get(s.id)?.idempotencyKey, s.idempotencyKey);
  } finally { db.close(); }
});

test("policy is independent of contact/provider identity, contact unlinking preserves history and owner deletion cascades", async () => {
  const db = await legacy();
  try {
    await migrate(db); const f = fixture(db, "privacy"), m = membership(db, "privacy", f), r = reason(db, "privacy", f, m.id), s = send(db, "privacy", f, m.id);
    insert(db, "EmailSubscription", { id: "consent", ...f.scope, addressDigest: f.addressDigest, category: "newsletter", state: "OPTED_IN", changedAt: now, provenance: "{}" });
    insert(db, "EmailSuppression", { id: "hold", ...f.scope, addressDigest: f.addressDigest, category: "*", reason: "COMPLAINT" });
    assert.throws(() => insert(db, "EmailSubscription", { id: "wildcard", ...f.scope, addressDigest: f.addressDigest, category: "*", changedAt: now, provenance: "{}" }), /CHECK/);
    assert.throws(() => insert(db, "EmailSuppression", { id: "duplicate-hold", ...f.scope, addressDigest: f.addressDigest, category: "*", reason: "COMPLAINT" }), /UNIQUE/);
    db.prepare('UPDATE "MessageSend" SET "status"=\'CANCELLED\',"payloadCiphertext"=NULL,"providerMessageId"=NULL,"redactedAt"=? WHERE "id"=?').run(now, s.id);
    db.prepare('UPDATE "CampaignMembershipReason" SET "endedAt"=?,"endReason"=\'CONTACT_DELETED\',"note"=NULL,"redactedAt"=? WHERE "id"=?').run(now, now, r.id);
    db.prepare('UPDATE "CampaignMembership" SET "status"=\'STOPPED\',"stoppedAt"=?,"endedAt"=? WHERE "id"=?').run(now, now, m.id);
    db.prepare('UPDATE "FunnelContact" SET "email"=NULL,"name"=NULL,"deletedAt"=? WHERE "id"=?').run(now, f.contactId);
    db.prepare('UPDATE "FunnelSubject" SET "contactId"=NULL WHERE "id"=?').run(f.subjectId);
    assert.equal(db.prepare('SELECT "contactId" FROM "CampaignMembership" WHERE "id"=?').get(m.id)?.contactId, f.contactId);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "EmailSuppression"').get()?.n, 1);
    assert.throws(() => membership(db, "recreated", f, { cycle: 2 }), /must match/);
    db.prepare('DELETE FROM "User" WHERE "id"=?').run(f.scope.ownerId);
    for (const table of ["EmailConnection", "EmailSender", "MarketingCampaign", "CampaignRevision", "CampaignStep", "CampaignMembership", "CampaignMembershipReason", "MessageSend", "EmailSubscription", "EmailSuppression"])
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get()?.n, 0, `${table} must cascade`);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});
