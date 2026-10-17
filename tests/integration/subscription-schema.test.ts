import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const root = "apps/web/prisma/migrations", migration = "20261017040000_subscription_subject", now = "2026-10-19T10:00:00.000Z";
type Values = Record<string, string | number | null>;
function insert(db: DatabaseSync, table: string, value: Values) {
  const keys = Object.keys(value);
  db.prepare(`INSERT INTO "${table}" (${keys.map(k => `"${k}"`).join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(value));
}
async function database(fresh = false) {
  const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON");
  if (!fresh) db.exec(await readFile("tests/fixtures/legacy-account-schema.sql", "utf8"));
  for (const name of (await readdir(root)).sort()) if (/^\d{14}_/.test(name) && name < migration && (fresh || name >= "20261013000000_customer_connections"))
    db.exec(await readFile(`${root}/${name}/migration.sql`, "utf8"));
  return db;
}
async function migrate(db: DatabaseSync) {
  db.exec(await readFile(`${root}/${migration}/migration.sql`, "utf8"));
  assert.equal(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
}
function setup(db: DatabaseSync, kind = "SALES") {
  insert(db, "User", { id: "owner", name: "Owner" });
  const scope = { ownerId: "owner", environment: "TEST" };
  insert(db, "TrackingSource", { id: "source", ...scope, provider: "API", externalAccountId: "account", name: "Bridge", config: "{}", ingressTokenHash: "token", updatedAt: now });
  insert(db, "FunnelContact", { id: "contact", ...scope, email: "maya@example.test" });
  insert(db, "FunnelSubject", { id: "subject", ...scope, kind, contactId: "contact" });
  insert(db, "FunnelSubjectReference", { id: "reference", ...scope, sourceId: "source", subjectId: "subject", kind: kind === "SUBSCRIPTION" ? kind : "ENQUIRY", externalId: "external-a" });
  insert(db, "Funnel", { id: "funnel", ...scope, name: "Journey", subjectKind: kind, draft: "{}", automationEnrolmentEnabled: 1, automationDispatchEnabled: 1, updatedAt: now });
  insert(db, "FunnelVersion", { id: "version", ...scope, funnelId: "funnel", number: 1, definition: "{}", digest: "digest", publishedAt: now });
  insert(db, "FunnelStage", { id: "stage", ...scope, versionId: "version", key: "active", name: "Active", goal: 1 });
  db.prepare('UPDATE "Funnel" SET "publishedVersionId"=? WHERE id=?').run("version", "funnel");
  insert(db, "FunnelJourney", { id: "journey", ...scope, funnelId: "funnel", versionId: "version", subjectId: "subject", currentStageKey: "active" });
  insert(db, "FunnelStageTransition", { id: "transition", ...scope, journeyId: "journey", versionId: "version", sequence: 1, toStageKey: "active", triggerKind: "MANUAL", mode: "REPLAY", reasonCode: "MANUAL_ENTRY", evaluationTrace: "{}", occurredAt: now });
  insert(db, "TrackingEvent", { id: "event", ...scope, sourceId: "source", sourceGeneration: 1, type: "custom.fixture", dedupeKey: "delivery", rawPayloadDigest: "digest", envelope: "{}", subjectId: "subject", contactId: "contact", occurredAt: now, expiresAt: now });
  return scope;
}

test("subscription migration preserves populated legacy parent data, all prior triggers, child FKs and automation controls", async () => {
  const db = await database(); try {
    setup(db);
    const schema = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table','index','trigger')").all();
    const subjects = db.prepare('SELECT * FROM "FunnelSubject"').all(), funnels = db.prepare('SELECT * FROM "Funnel"').all();
    await migrate(db);
    assert.deepEqual(db.prepare('SELECT * FROM "FunnelSubject"').all(), subjects);
    assert.deepEqual(db.prepare('SELECT * FROM "Funnel"').all(), funnels);
    for (const row of schema) if (!["FunnelSubject", "Funnel"].includes(String(row.name)))
      assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE type=? AND name=?").get(row.type, row.name)?.sql, row.sql, `${row.name} changed`);
    assert.equal(db.prepare('SELECT subjectId FROM "TrackingEvent" WHERE id=\'event\'').get()?.subjectId, "subject");
    assert.throws(() => db.exec('UPDATE "Funnel" SET subjectKind=\'SUBSCRIPTION\''), /immutable/);
    assert.throws(() => db.exec('UPDATE "FunnelVersion" SET definition=\'changed\''), /immutable/);
    assert.throws(() => db.exec('UPDATE "TrackingEvent" SET sourceGeneration=2'), /immutable/);
    assert.throws(() => db.exec('DELETE FROM "FunnelStageTransition"'), /retained/);
  } finally { db.close(); }
});

test("fresh migrations support independent subscriptions but reject cross-scope, collapsing and rewritten identities", async () => {
  const db = await database(true); try {
    await migrate(db); const scope = setup(db, "SUBSCRIPTION");
    insert(db, "FunnelSubject", { id: "second", ...scope, kind: "SUBSCRIPTION", contactId: "contact" });
    const ref = { ...scope, sourceId: "source", subjectId: "second", kind: "SUBSCRIPTION", externalId: "external-b" };
    insert(db, "FunnelSubjectReference", { id: "second-ref", ...ref });
    assert.throws(() => insert(db, "FunnelSubjectReference", { id: "collapse", ...ref, subjectId: "subject" }), /UNIQUE/);
    assert.throws(() => insert(db, "FunnelSubjectReference", { id: "repeat-id", ...ref, externalId: "external-a" }), /UNIQUE/);
    insert(db, "FunnelSubject", { id: "sales", ...scope, kind: "SALES" });
    assert.throws(() => insert(db, "FunnelSubjectReference", { id: "wrong-kind", ...ref, subjectId: "sales", externalId: "new" }), /Subscription references/);
    assert.throws(() => insert(db, "FunnelSubjectReference", { id: "workspace-alias", ...ref, kind: "WORKSPACE", externalId: "shared" }), /Subscription references/);
    assert.throws(() => db.exec('UPDATE "FunnelSubject" SET kind=\'PURCHASE\' WHERE id=\'subject\''), /immutable/);
    for (const assignment of ["externalId='replacement'", "subjectId='second'", "kind='ORDER'", "sourceId='elsewhere'"])
      assert.throws(() => db.exec(`UPDATE "FunnelSubjectReference" SET ${assignment} WHERE id='reference'`), /immutable|Subscription references/);
    insert(db, "User", { id: "other", name: "Other" });
    assert.throws(() => insert(db, "FunnelSubject", { id: "wrong-owner", ownerId: "other", environment: "TEST", kind: "SUBSCRIPTION", contactId: "contact" }), /FOREIGN KEY/);
    assert.throws(() => insert(db, "FunnelSubject", { id: "wrong-environment", ownerId: "owner", environment: "LIVE", kind: "SUBSCRIPTION", contactId: "contact" }), /FOREIGN KEY/);
    assert.throws(() => insert(db, "FunnelSubjectReference", { id: "wrong-ref-environment", ...ref, environment: "LIVE", externalId: "new" }), /FOREIGN KEY|UNIQUE/);
    db.exec('UPDATE "FunnelSubject" SET contactId=NULL WHERE id=\'subject\'');
    assert.equal(db.prepare('SELECT contactId FROM "FunnelSubject" WHERE id=\'subject\'').get()?.contactId, null, "privacy unlink remains supported");
    db.exec('DELETE FROM "User" WHERE id=\'owner\'');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM "FunnelSubject"').get()?.n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM "FunnelJourney"').get()?.n, 0);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});
