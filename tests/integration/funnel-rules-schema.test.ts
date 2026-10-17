import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const migrationRoot = "apps/web/prisma/migrations";
const rulesMigration = "20261017010000_funnel_rules";
const now = "2026-10-17T12:00:00.000Z";
type Values = Record<string, string | number | null>;

function insert(db: DatabaseSync, table: string, values: Values) {
  const keys = Object.keys(values);
  db.prepare(`INSERT INTO "${table}" (${keys.map(key => `"${key}"`).join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(values));
}
async function legacyDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(await readFile("tests/fixtures/legacy-account-schema.sql", "utf8"));
  for (const name of (await readdir(migrationRoot)).sort()) {
    if (name >= "20261013000000_customer_connections" && name < rulesMigration && /^\d{14}_/.test(name))
      db.exec(await readFile(`${migrationRoot}/${name}/migration.sql`, "utf8"));
  }
  return db;
}
async function migrate(db: DatabaseSync) {
  db.exec(await readFile(`${migrationRoot}/${rulesMigration}/migration.sql`, "utf8"));
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
}
function tracking(db: DatabaseSync, suffix: string, ownerId = "owner-a", environment = "TEST") {
  const scope = { ownerId, environment };
  insert(db, "TrackingSource", { id: `source-${suffix}`, ...scope, provider: "API", externalAccountId: suffix, name: "Fixture", config: "{}", ingressTokenHash: `token-${suffix}`, updatedAt: now });
  insert(db, "FunnelSubject", { id: `subject-${suffix}`, ...scope, kind: "SALES" });
  return { scope, sourceId: `source-${suffix}`, subjectId: `subject-${suffix}` };
}
function event(db: DatabaseSync, suffix: string, source: ReturnType<typeof tracking>, status = "MATCHED", extra: Values = {}) {
  insert(db, "TrackingEvent", { id: `event-${suffix}`, ...source.scope, sourceId: source.sourceId, sourceGeneration: 7, type: "enquiry.accepted", dedupeKey: suffix,
    rawPayloadDigest: `digest-${suffix}`, envelope: "{}", subjectId: source.subjectId, status, occurredAt: now, expiresAt: "2027-04-17T12:00:00.000Z", ...extra });
  return `event-${suffix}`;
}
function funnel(db: DatabaseSync, suffix: string, source: ReturnType<typeof tracking>) {
  const funnelId = `funnel-${suffix}`, versionId = `version-${suffix}`;
  insert(db, "Funnel", { id: funnelId, ...source.scope, name: "Fixture funnel", subjectKind: "SALES", draft: "{}", updatedAt: now });
  insert(db, "FunnelVersion", { id: versionId, ...source.scope, funnelId, number: 1, definition: "{}", digest: `definition-${suffix}`, publishedAt: now });
  for (const key of ["start", "goal"])
    insert(db, "FunnelStage", { id: `stage-${suffix}-${key}`, ...source.scope, versionId, key, name: key, goal: key === "goal" ? 1 : 0 });
  db.prepare('UPDATE "Funnel" SET "publishedVersionId" = ? WHERE "id" = ?').run(versionId, funnelId);
  return { funnelId, versionId };
}
function journey(db: DatabaseSync, suffix: string, source: ReturnType<typeof tracking>, definition: ReturnType<typeof funnel>, extra: Values = {}) {
  const values = { id: `journey-${suffix}`, ...source.scope, ...definition, subjectId: source.subjectId, currentStageKey: "start", ...extra };
  insert(db, "FunnelJourney", values);
  return values;
}
function receipt(db: DatabaseSync, suffix: string, source: ReturnType<typeof tracking>, eventId: string, extra: Values = {}) {
  const values = { id: `receipt-${suffix}`, ...source.scope, eventId, subjectId: source.subjectId, matchRevision: 1, mode: "LIVE", ...extra };
  insert(db, "FunnelEvaluationReceipt", values);
  return values;
}
function transition(db: DatabaseSync, suffix: string, source: ReturnType<typeof tracking>, run: ReturnType<typeof journey>, extra: Values = {}) {
  const values = { id: `transition-${suffix}`, ...source.scope, journeyId: run.id, versionId: run.versionId, sequence: 1, toStageKey: "start", triggerKind: "MANUAL",
    mode: "LIVE", reasonCode: "MANUAL_ENTRY", note: "Private customer context", evaluationTrace: '{"privateValue":"sensitive"}', occurredAt: now, ...extra };
  insert(db, "FunnelStageTransition", values);
  return values;
}

test("rules migration preserves legacy constraints and evidence, and seeds historical matches as BACKFILL", async () => {
  const db = await legacyDatabase();
  try {
    insert(db, "User", { id: "owner-a", name: "Owner A" });
    const source = tracking(db, "historical");
    event(db, "matched", source);
    for (const status of ["QUEUED", "UNMATCHED", "REDACTED"]) event(db, status, source, status);
    const prior = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE type IN ('table','index','trigger') AND sql IS NOT NULL").all();
    await migrate(db);
    for (const row of prior) {
      if (row.name === "TrackingEvent") continue; // Only this table receives one additive column.
      const after = db.prepare("SELECT sql FROM sqlite_master WHERE type=? AND name=?").get(row.type, row.name);
      assert.equal(after?.sql, row.sql, `${String(row.name)} must retain its exact definition`);
    }
    assert.deepEqual({ ...db.prepare('SELECT "sourceGeneration", "ingestionMode", "processingMode", "matchRevision" FROM "TrackingEvent" WHERE "id"=\'event-matched\'').get() },
      { sourceGeneration: 7, ingestionMode: "LIVE", processingMode: "LIVE", matchRevision: 1 });
    assert.deepEqual({ ...db.prepare('SELECT "eventId", "matchRevision", "mode", "status" FROM "FunnelEvaluationReceipt"').get() },
      { eventId: "event-matched", matchRevision: 1, mode: "BACKFILL", status: "PENDING" });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "TrackingEvent" WHERE "matchRevision"=0').get()?.n, 3);
    assert.throws(() => db.exec('UPDATE "TrackingEvent" SET "sourceGeneration"=8 WHERE "id"=\'event-matched\''), /immutable/);
    assert.throws(() => event(db, "bad-environment", source, "MATCHED", { environment: "INVALID" }), /CHECK/);
    assert.throws(() => insert(db, "Campaign", { id: "invalid-category", name: "Legacy", objective: "LEADS", status: "DRAFT", budget: "{}", targeting: "{}", category: "EMAIL_MARKETING" }), /CHECK/);
  } finally { db.close(); }
});

test("funnel foreign keys enforce owner, environment, pinned stages, cycle and one active journey", async () => {
  const db = await legacyDatabase();
  try {
    await migrate(db);
    for (const id of ["owner-a", "owner-b"]) insert(db, "User", { id, name: id });
    const a = tracking(db, "a"), b = tracking(db, "b", "owner-b"), live = tracking(db, "live", "owner-a", "LIVE");
    const fa = funnel(db, "a", a), fb = funnel(db, "b", b), fl = funnel(db, "live", live), other = funnel(db, "other", a);
    const run = journey(db, "a", a, fa);
    assert.throws(() => journey(db, "wrong-owner", a, fb), /FOREIGN KEY/);
    assert.throws(() => journey(db, "wrong-environment", a, fl), /FOREIGN KEY/);
    assert.throws(() => journey(db, "wrong-funnel", a, { ...fa, versionId: other.versionId }, { cycle: 2, status: "CANCELLED" }), /FOREIGN KEY/);
    assert.throws(() => journey(db, "wrong-stage", a, fa, { subjectId: live.subjectId, currentStageKey: "missing" }), /FOREIGN KEY/);
    assert.throws(() => journey(db, "duplicate-cycle", a, fa), /UNIQUE/);
    assert.throws(() => journey(db, "duplicate-active", a, fa, { cycle: 2 }), /UNIQUE/);
    assert.throws(() => transition(db, "wrong-version", a, run, { versionId: other.versionId }), /FOREIGN KEY/);
    assert.throws(() => db.prepare('UPDATE "Funnel" SET "publishedVersionId"=? WHERE "id"=?').run(other.versionId, fa.funnelId), /FOREIGN KEY/);
    assert.throws(() => db.prepare('UPDATE "FunnelJourney" SET "versionId"=? WHERE "id"=?').run(other.versionId, run.id), /immutable/);
    db.prepare('UPDATE "FunnelJourney" SET "status"=\'SUCCEEDED\', "endedAt"=? WHERE "id"=?').run(now, run.id);
    journey(db, "explicit-next-cycle", a, fa, { cycle: 2 });
    // A goal stage need not be terminal; a later event can still route it to refund.
    assert.equal(db.prepare('SELECT "terminal" FROM "FunnelStage" WHERE "versionId"=? AND "key"=\'goal\'').get(fa.versionId)?.terminal, "NONE");
    assert.throws(() => db.prepare('UPDATE "FunnelVersion" SET "definition"=\'{}\' WHERE "id"=?').run(fa.versionId), /immutable/);
    assert.throws(() => db.prepare('UPDATE "FunnelStage" SET "name"=\'Changed\' WHERE "versionId"=?').run(fa.versionId), /immutable/);
    assert.throws(() => db.prepare('DELETE FROM "FunnelJourney" WHERE "id"=?').run(run.id), /retained/);
  } finally { db.close(); }
});

test("manual commands, canonical evidence and internal outbox dedupe survive privacy redaction", async () => {
  const db = await legacyDatabase();
  try {
    await migrate(db);
    insert(db, "User", { id: "owner-a", name: "Owner A" });
    insert(db, "User", { id: "owner-b", name: "Owner B" });
    const a = tracking(db, "a"), fa = funnel(db, "a", a), run = journey(db, "a", a, fa);
    const t = transition(db, "a", a, run, { commandKey: "manual-1", commandDigest: "digest-1" });
    const effect = { id: "effect-a", ...a.scope, ...fa, subjectId: a.subjectId, journeyId: run.id, cycle: 1, evidenceKey: "fact:canonical-order-payment", outcome: "MOVED" };
    insert(db, "FunnelEvidenceEffect", effect);
    const outbox = { id: "outbox-a", ...a.scope, journeyId: run.id, transitionId: t.id, kind: "STAGE_ENTERED", actionKey: "stage-entered", payload: '{"privateValue":"sensitive"}', mode: "LIVE" };
    insert(db, "FunnelActionOutbox", outbox);
    assert.throws(() => transition(db, "duplicate-command", a, run, { sequence: 2, commandKey: "manual-1", commandDigest: "different-request" }), /UNIQUE/);
    assert.throws(() => transition(db, "unpaired-command", a, run, { sequence: 2, commandKey: "manual-2" }), /CHECK/);
    assert.throws(() => insert(db, "FunnelEvidenceEffect", { ...effect, id: "duplicate-effect" }), /UNIQUE/);
    assert.throws(() => insert(db, "FunnelEvidenceEffect", { ...effect, id: "wrong-cycle", evidenceKey: "event:another", cycle: 2 }), /FOREIGN KEY/);
    assert.throws(() => insert(db, "FunnelActionOutbox", { ...outbox, id: "duplicate-outbox" }), /UNIQUE/);
    assert.throws(() => insert(db, "FunnelActionOutbox", { ...outbox, id: "external-send", actionKey: "email", kind: "SEND_EMAIL" }), /CHECK/);
    assert.throws(() => insert(db, "FunnelActionOutbox", { ...outbox, id: "external-eligibility", actionKey: "other", effectEligibility: "LIVE" }), /CHECK/);
    for (const table of ["Funnel", "FunnelVersion", "FunnelStage", "FunnelJourney", "FunnelStageTransition", "FunnelEvidenceEffect", "FunnelActionOutbox"])
      assert.throws(() => db.prepare(`UPDATE "${table}" SET "ownerId"='owner-b' WHERE "ownerId"='owner-a'`).run(), /immutable|append-only/);
    assert.throws(() => db.prepare('UPDATE "FunnelStageTransition" SET "note"=NULL WHERE "id"=?').run(t.id), /append-only/);
    assert.throws(() => db.prepare('UPDATE "FunnelStageTransition" SET "redactedAt"=? WHERE "id"=?').run(now, t.id), /append-only|CHECK/);
    db.prepare('UPDATE "FunnelStageTransition" SET "note"=NULL, "evaluationTrace"=\'{}\', "redactedAt"=? WHERE "id"=?').run(now, t.id);
    assert.equal(db.prepare('SELECT "commandKey" FROM "FunnelStageTransition" WHERE "id"=?').get(t.id)?.commandKey, "manual-1");
    assert.throws(() => db.prepare('UPDATE "FunnelStageTransition" SET "note"=\'restored\' WHERE "id"=?').run(t.id), /append-only|CHECK/);
    assert.throws(() => db.prepare('UPDATE "FunnelStageTransition" SET "redactedAt"=NULL WHERE "id"=?').run(t.id), /append-only/);
    assert.throws(() => db.prepare('UPDATE "FunnelStageTransition" SET "toStageKey"=\'goal\' WHERE "id"=?').run(t.id), /append-only/);
    assert.throws(() => db.prepare('DELETE FROM "FunnelStageTransition" WHERE "id"=?').run(t.id), /retained/);
    assert.throws(() => db.prepare('DELETE FROM "FunnelEvidenceEffect" WHERE "id"=?').run(effect.id), /retained/);
    assert.throws(() => db.prepare('UPDATE "FunnelActionOutbox" SET "payload"=\'{}\' WHERE "id"=?').run(outbox.id), /cancellation/);
    db.prepare('UPDATE "FunnelActionOutbox" SET "status"=\'CANCELLED\', "payload"=\'{}\' WHERE "id"=?').run(outbox.id);
    assert.throws(() => db.prepare('UPDATE "FunnelActionOutbox" SET "status"=\'RECORDED\' WHERE "id"=?').run(outbox.id), /reactivated/);
    // Account deletion remains valid even though individual history deletion is forbidden.
    db.prepare('DELETE FROM "User" WHERE "id"=\'owner-a\'').run();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "FunnelStageTransition"').get()?.n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "User"').get()?.n, 1);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});

test("evaluation receipts bind the current match revision and retain completed replay protection", async () => {
  const db = await legacyDatabase();
  try {
    await migrate(db);
    for (const id of ["owner-a", "owner-b"]) insert(db, "User", { id, name: id });
    const a = tracking(db, "a"), b = tracking(db, "b", "owner-b"), another = tracking(db, "another");
    const eventId = event(db, "a", a, "MATCHED", { matchRevision: 1 });
    const r = receipt(db, "a", a, eventId);
    assert.throws(() => receipt(db, "duplicate", a, eventId), /UNIQUE/);
    assert.throws(() => receipt(db, "future-revision", a, eventId, { matchRevision: 2 }), /current matched/);
    assert.throws(() => receipt(db, "cross-owner", b, eventId), /current matched/);
    assert.throws(() => receipt(db, "wrong-subject", another, eventId), /current matched/);
    assert.throws(() => db.prepare('UPDATE "TrackingEvent" SET "matchRevision"=0 WHERE "id"=?').run(eventId), /cannot decrease/);
    assert.throws(() => db.prepare('UPDATE "FunnelEvaluationReceipt" SET "mode"=\'REPLAY\' WHERE "id"=?').run(r.id), /immutable/);
    db.prepare('UPDATE "FunnelEvaluationReceipt" SET "status"=\'CONSUMED\', "completedAt"=? WHERE "id"=?').run(now, r.id);
    assert.throws(() => db.prepare('UPDATE "FunnelEvaluationReceipt" SET "status"=\'PENDING\' WHERE "id"=?').run(r.id), /reactivated/);
    assert.throws(() => db.prepare('DELETE FROM "FunnelEvaluationReceipt" WHERE "id"=?').run(r.id), /retained/);
    db.prepare('UPDATE "TrackingEvent" SET "matchRevision"=2, "processingMode"=\'REPLAY\' WHERE "id"=?').run(eventId);
    receipt(db, "replay", a, eventId, { matchRevision: 2, mode: "REPLAY" });
    insert(db, "FunnelPropertySnapshot", { id: "snapshot-a", ...a.scope, subjectId: a.subjectId, sourceId: a.sourceId, eventType: "enquiry.accepted", fields: "{}", updatedAt: now });
    assert.throws(() => db.exec('UPDATE "FunnelPropertySnapshot" SET "sourceId"=\'source-another\''), /immutable/);
    assert.throws(() => insert(db, "FunnelPropertySnapshot", { id: "snapshot-cross-owner", ...a.scope, subjectId: a.subjectId, sourceId: b.sourceId, eventType: "order.paid", fields: "{}", updatedAt: now }), /FOREIGN KEY/);
    db.exec('DELETE FROM "FunnelPropertySnapshot"'); // Privacy removal needs no retained values.
    db.prepare('DELETE FROM "User" WHERE "id"=\'owner-a\'').run();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "FunnelEvaluationReceipt"').get()?.n, 0);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});
