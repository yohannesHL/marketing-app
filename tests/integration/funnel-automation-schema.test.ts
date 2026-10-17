import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const migrationRoot = "apps/web/prisma/migrations", migrationName = "20261017030000_funnel_automation";
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
function fixture(db: DatabaseSync, suffix: string, ownerId = "owner-a", environment = "TEST", scopeKind = "SUBJECT", wait = '{"kind":"IMMEDIATE"}') {
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
  insert(db, "CampaignStep", { id: stepId, ...scope, revisionId, key: "welcome", position: 0, subject: "Welcome", text: "Reviewed body", wait });
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
  insert(db, "FunnelStageTransition", { id: transitionId, ...scope, journeyId, versionId, sequence: 1, toStageKey: "welcome", triggerKind: "EVENT", recordedAt: now, mode: "LIVE", reasonCode: "MANUAL_ENTRY", evaluationTrace: "{}", occurredAt: now });
  return { journeyId, transitionId, versionId, stageKey: "welcome" };
}

function action(db: DatabaseSync, suffix: string, f: ReturnType<typeof fixture>, membershipId?: string) {
  const origin = journey(db, suffix, f.scope, f.subjectId), outboxId = `outbox-${suffix}`, id = `action-${suffix}`;
  const plan = { id: "enrol", stageId: origin.stageKey, kind: "EMAIL_ENROLL", campaignId: f.campaignId, revisionId: f.revisionId,
    delaySeconds: 0, expiresAfterDueSeconds: 86400, stopOnStageExit: true, stopOnGoal: true };
  insert(db, "FunnelActionOutbox", { id: outboxId, ...f.scope, journeyId: origin.journeyId, transitionId: origin.transitionId,
    kind: "STAGE_ENTERED", actionKey: "entry", payload: JSON.stringify({ schemaVersion: 1, stageId: origin.stageKey, versionId: origin.versionId, actions: [plan] }),
    mode: "LIVE", effectEligibility: "AUTOMATION", createdAt: now });
  const values = { id, ...f.scope, outboxId, ...origin, actionKey: "enrol", kind: "EMAIL_ENROLL", campaignId: f.campaignId,
    requestedRevisionId: f.revisionId, membershipId: membershipId ?? null, plan: JSON.stringify(plan), mode: "LIVE", dueAt: now, expiresAt: later,
    createdAt: now, updatedAt: now };
  insert(db, "FunnelActionExecution", values); return { ...values, origin, plan };
}
function execution(db: DatabaseSync, suffix: string, f: ReturnType<typeof fixture>, membershipId: string, extra: Values = {}) {
  const values = { id: `execution-${suffix}`, ...f.scope, membershipId, revisionId: f.revisionId, stepId: f.stepId,
    authorizationKind: "MANUAL", authorizationRequestKey: `start-${suffix}`, authorizationRequestDigest: `start-digest-${suffix}`,
    authorizationActorId: f.scope.ownerId, authorizationReason: "Requested follow-up", sequenceAnchorAt: now, waitStartedAt: now, waitAnchorAt: now,
    dueAt: now, expiresAt: later, status: "READY", resolvedAt: now, createdAt: now, updatedAt: now, ...extra };
  insert(db, "CampaignStepExecution", values); return values;
}
function eventFixture(db: DatabaseSync, suffix: string, f: ReturnType<typeof fixture>, generation: number | null = 1, mode = "LIVE") {
  const eventId = `event-${suffix}`, receiptId = `evaluation-${suffix}`;
  insert(db, "TrackingEvent", { id: eventId, ...f.scope, sourceId: f.sourceId, sourceGeneration: 1, type: "email.delivered", dedupeKey: suffix,
    rawPayloadDigest: suffix, envelope: "{}", status: "MATCHED", subjectId: f.subjectId, matchRevision: 1, occurredAt: now, expiresAt: later });
  insert(db, "FunnelEvaluationReceipt", { id: receiptId, ...f.scope, eventId, subjectId: f.subjectId, matchRevision: 1, mode,
    sourceGeneration: generation, createdAt: now });
  return { eventId, receiptId, matchRevision: 1, evidenceAvailableAt: now };
}

test("automation migration preserves legacy records and leaves previous authority inert", async () => {
  const db = await legacy();
  try {
    const f = fixture(db, "old"), m = membership(db, "old", f), origin = journey(db, "old", f.scope, f.subjectId);
    const r = reason(db, "old", f, m.id, { kind: "STAGE", ...origin });
    const message = send(db, "old", f, m.id); receipt(db, "old", f, { sendId: message.id });
    insert(db, "FunnelActionOutbox", { id: "old-outbox", ...f.scope, journeyId: origin.journeyId, transitionId: origin.transitionId,
      kind: "STAGE_ENTERED", actionKey: "entry", payload: '{"actions":[]}', mode: "LIVE" });
    insert(db, "TrackingEvent", { id: "old-event", ...f.scope, sourceId: f.sourceId, sourceGeneration: 1, type: "email.sent", dedupeKey: "old",
      rawPayloadDigest: "old", envelope: "{}", status: "MATCHED", subjectId: f.subjectId, matchRevision: 1, occurredAt: now, expiresAt: later });
    insert(db, "FunnelEvaluationReceipt", { id: "old-evaluation", ...f.scope, eventId: "old-event", subjectId: f.subjectId, matchRevision: 1, mode: "LIVE" });
    insert(db, "FunnelEvidenceEffect", { id: "old-effect", ...f.scope, funnelId: "funnel-old", versionId: origin.versionId,
      subjectId: f.subjectId, journeyId: origin.journeyId, evidenceKey: "old-event", outcome: "UNKNOWN_CONDITION", ruleId: "stop" });
    const objects = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL").all();
    await migrate(db);
    for (const row of objects) assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE type=? AND name=?").get(row.type, row.name)?.sql, row.sql, `${row.name} changed`);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM "FunnelActionExecution"').get()?.n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM "CampaignStepExecution"').get()?.n, 0);
    assert.equal(db.prepare('SELECT "automationEnrolmentEnabled" FROM "Funnel"').get()?.automationEnrolmentEnabled, 0);
    assert.equal(db.prepare('SELECT "sourceGeneration" FROM "FunnelEvaluationReceipt" WHERE id=\'old-evaluation\'').get()?.sourceGeneration, null);
    assert.equal(db.prepare('SELECT "evaluationEventId" FROM "FunnelEvidenceEffect" WHERE id=\'old-effect\'').get()?.evaluationEventId, null);
    assert.equal(db.prepare('SELECT "actionExecutionId" FROM "CampaignMembershipReason" WHERE id=?').get(r.id)?.actionExecutionId, null);
    assert.equal(db.prepare('SELECT "payloadCiphertext" FROM "MessageSend" WHERE id=?').get(message.id)?.payloadCiphertext, "vaulted-request");
    assert.throws(() => db.exec('UPDATE "FunnelEvaluationReceipt" SET "sourceGeneration"=1'), /immutable/);
    assert.throws(() => db.exec('UPDATE "FunnelActionOutbox" SET "effectEligibility"=\'AUTOMATION\''), /immutable/);
    assert.throws(() => db.exec('UPDATE "FunnelActionOutbox" SET "status"=\'CONSUMED\''), /replay/);
    assert.throws(() => reason(db, "invented-stage", f, m.id, { kind: "STAGE", ...origin }), /captured enrollment/);
    const invalid = { id: "invented", ...f.scope, outboxId: "old-outbox", ...origin, actionKey: "invented", kind: "EMAIL_STOP", campaignId: f.campaignId,
      plan: '{"id":"invented"}', mode: "LIVE", dueAt: now, updatedAt: now };
    assert.throws(() => insert(db, "FunnelActionExecution", invalid), /original captured/);
    assert.equal(db.prepare('PRAGMA foreign_key_list("MessageSend")').all().some(row => row.table === "EmailSender"), true);
  } finally { db.close(); }
});

test("captured stage actions own immutable membership reasons and terminal tombstones", async () => {
  const db = await legacy();
  try {
    await migrate(db); const f = fixture(db, "action"), m = membership(db, "action", f), a = action(db, "action", f, m.id);
    const r = reason(db, "action", f, m.id, { kind: "STAGE", ...a.origin, actionExecutionId: a.id, stopOnStageExit: 1, stopOnGoal: 1 });
    assert.throws(() => reason(db, "wrong-flags", f, m.id, { kind: "STAGE", ...a.origin, actionExecutionId: a.id, stopOnStageExit: 0, stopOnGoal: 1 }), /captured enrollment/);
    assert.throws(() => db.exec('UPDATE "CampaignMembershipReason" SET "stopOnGoal"=0'), /immutable/);
    assert.throws(() => db.exec('UPDATE "FunnelActionExecution" SET "plan"=\'{}\''), /immutable/);
    assert.throws(() => db.exec('UPDATE "FunnelActionExecution" SET "dueAt"=\'2026-10-20T00:00:00Z\''), /immutable/);
    db.prepare('UPDATE "FunnelActionExecution" SET status=\'APPLIED\',"completedAt"=?,"evaluationTrace"=\'{"decision":"applied"}\' WHERE id=?').run(now, a.id);
    assert.throws(() => db.exec('UPDATE "FunnelActionExecution" SET status=\'PENDING\',"completedAt"=NULL'), /cannot be changed/);
    assert.throws(() => db.exec('UPDATE "FunnelActionExecution" SET "evaluationTrace"=\'{}\''), /immutable/);
    db.prepare('UPDATE "FunnelActionExecution" SET "evaluationTrace"=\'{}\',"redactedAt"=?').run(now);
    assert.throws(() => db.exec('DELETE FROM "FunnelActionExecution"'), /retained/);
    db.prepare('UPDATE "CampaignMembershipReason" SET "endedAt"=?,"endReason"=\'EXIT\',"note"=NULL,"redactedAt"=? WHERE id=?').run(now, now, r.id);
    db.prepare('UPDATE "FunnelActionOutbox" SET status=\'CONSUMED\',"completedAt"=?').run(now);
    db.exec('UPDATE "FunnelActionOutbox" SET status=\'CANCELLED\',payload=\'{}\'');
    assert.throws(() => db.prepare('UPDATE "FunnelActionOutbox" SET "completedAt"=?').run(later), /immutable/);
  } finally { db.close(); }
});

test("explicit start commands cannot cross ownership, fork cadence or change pinned delivery identity", async () => {
  const db = await legacy();
  try {
    await migrate(db); const f = fixture(db, "start"), m = membership(db, "start", f), other = fixture(db, "other", "owner-b"), om = membership(db, "other", other);
    const e = execution(db, "start", f, m.id);
    assert.throws(() => execution(db, "cross", f, om.id), /FOREIGN KEY/);
    assert.throws(() => execution(db, "duplicate", f, m.id), /UNIQUE/);
    assert.throws(() => db.exec('UPDATE "CampaignStepExecution" SET "authorizationRequestDigest"=\'changed\''), /immutable/);
    const message = send(db, "start", f, m.id);
    db.prepare('UPDATE "CampaignStepExecution" SET "sendId"=?,status=\'SEND_PENDING\' WHERE id=?').run(message.id, e.id);
    db.prepare('UPDATE "MessageSend" SET status=\'UNKNOWN\',"firstSubmittedAt"=?,"idempotencyExpiresAt"=?').run(now, later);
    assert.throws(() => db.prepare('UPDATE "CampaignStepExecution" SET status=\'SKIPPED\',"completedAt"=?').run(later), /uncertainty/);
    db.prepare('UPDATE "MessageSend" SET status=\'ACCEPTED\',"acceptedAt"=?').run(now);
    db.prepare('UPDATE "CampaignStepExecution" SET status=\'ACCEPTED\',"completedAt"=?').run(now);
    insert(db, "CampaignStep", { id: "second-step", ...f.scope, revisionId: f.revisionId, key: "second", position: 1, subject: "Second", text: "Second" });
    const next = execution(db, "next", f, m.id, { stepId: "second-step", authorizationKind: "CONTINUATION", authorizationRequestKey: null,
      authorizationRequestDigest: null, authorizationActorId: null, authorizationReason: null, previousExecutionId: e.id });
    assert.throws(() => execution(db, "fork", f, m.id, { ...next, id: "fork", iteration: 2 }), /predecessor|UNIQUE/);
    assert.throws(() => db.exec('UPDATE "CampaignStepExecution" SET status=\'READY\',"completedAt"=NULL WHERE id=\'execution-start\''), /cannot be changed/);
    db.prepare('UPDATE "CampaignStepExecution" SET "authorizationReason"=NULL,"evaluationTrace"=\'{}\',"redactedAt"=? WHERE id=?').run(now, e.id);
    assert.throws(() => db.exec('UPDATE "CampaignStepExecution" SET "authorizationReason"=\'restored\' WHERE id=\'execution-start\''), /redaction/);
  } finally { db.close(); }
});

test("event waits bind original LIVE match availability and cannot reset generation or deadline", async () => {
  const db = await legacy();
  try {
    await migrate(db); const f = fixture(db, "wait"), m = membership(db, "wait", f);
    // The original first step is immutable; an EVENT-only revision supplies another owned membership.
    const revisionId = "wait-revision", stepId = "wait-step";
    insert(db, "CampaignRevision", { id: revisionId, ...f.scope, campaignId: f.campaignId, number: 2, definition: "{}", digest: "wait-digest", senderId: f.senderId,
      subscriptionCategory: "newsletter", sendWindow: "{}", publishedAt: now });
    insert(db, "CampaignStep", { id: stepId, ...f.scope, revisionId, key: "wait", position: 0, subject: "Wait", text: "Wait",
      wait: JSON.stringify({ kind: "EVENT", sourceId: f.sourceId, type: "email.delivered", anchor: "ENROLLED", timeoutSeconds: 86400, onTimeout: "SKIP_STEP" }) });
    db.prepare('UPDATE "CampaignMembership" SET status=\'STOPPED\',"endedAt"=? WHERE id=?').run(now, m.id);
    const wm = membership(db, "wait2", { ...f, revisionId }, { cycle: 2 });
    const ev = eventFixture(db, "valid", f), absent = eventFixture(db, "old-null", f, null), replay = eventFixture(db, "replay", f, 1, "REPLAY");
    const e = execution(db, "wait", { ...f, revisionId, stepId }, wm.id, { status: "WAITING", dueAt: null, expiresAt: null, resolvedAt: null,
      waitSourceId: f.sourceId, sourceGeneration: 1, waitDeadlineAt: later });
    const bind = (evidence: ReturnType<typeof eventFixture>) => db.prepare('UPDATE "CampaignStepExecution" SET "receiptId"=?,"eventId"=?,"matchRevision"=?,"evidenceAvailableAt"=?,"dueAt"=?,"expiresAt"=?,"resolvedAt"=?,status=\'READY\' WHERE id=?')
      .run(evidence.receiptId, evidence.eventId, evidence.matchRevision, evidence.evidenceAvailableAt, now, later, now, e.id);
    assert.throws(() => bind(absent), /original timely LIVE/); assert.throws(() => bind(replay), /original timely LIVE/);
    // A newer replay receipt cannot erase the earlier LIVE proof.
    db.exec('UPDATE "TrackingEvent" SET "matchRevision"=2,"processingMode"=\'REPLAY\' WHERE id=\'event-valid\'');
    bind(ev);
    assert.throws(() => db.prepare('UPDATE "CampaignStepExecution" SET "waitDeadlineAt"=?').run("2027-01-01T00:00:00Z"), /immutable/);
    assert.throws(() => db.exec('UPDATE "CampaignStepExecution" SET "sourceGeneration"=2'), /immutable/);
    assert.throws(() => db.exec('UPDATE "CampaignStepExecution" SET "receiptId"=NULL,"eventId"=NULL,"matchRevision"=NULL,"evidenceAvailableAt"=NULL'), /immutable/);
  } finally { db.close(); }
});

test("sender refresh requires the exact membership sender and paired fenced lease state", async () => {
  const db = await legacy();
  try {
    await migrate(db); const f = fixture(db, "refresh"), m = membership(db, "refresh", f), other = fixture(db, "refresh-other"), om = membership(db, "refresh-other", other);
    assert.throws(() => db.prepare('UPDATE "EmailSender" SET "refreshMembershipId"=? WHERE id=?').run(om.id, f.senderId), /pinned membership sender/);
    assert.throws(() => db.prepare('UPDATE "EmailSender" SET "refreshStatus"=\'CLAIMED\' WHERE id=?').run(f.senderId), /CHECK/);
    db.prepare('UPDATE "EmailSender" SET "refreshStatus"=\'CLAIMED\',"refreshMembershipId"=?,"refreshLeaseTokenHash"=\'lease\',"refreshLeaseUntil"=?,"refreshConnectionGeneration"=1,"refreshCredentialVersion"=1,"refreshLastAttemptAt"=? WHERE id=?')
      .run(m.id, later, now, f.senderId);
    assert.throws(() => db.prepare('UPDATE "EmailSender" SET "refreshStatus"=\'IDLE\' WHERE id=?').run(f.senderId), /CHECK/);
    db.prepare('UPDATE "EmailSender" SET "refreshStatus"=\'RETRY\',"refreshLeaseTokenHash"=NULL,"refreshLeaseUntil"=NULL,"refreshNextAttemptAt"=? WHERE id=?').run(later, f.senderId);
    const message = send(db, "refresh", f, m.id);
    db.prepare('UPDATE "MessageSend" SET "reconcileAttemptCount"=5 WHERE id=?').run(message.id);
    assert.throws(() => db.prepare('UPDATE "MessageSend" SET "reconcileAttemptCount"=0 WHERE id=?').run(message.id), /cannot reset/);
    assert.throws(() => db.prepare('UPDATE "EmailSender" SET "address"=\'other@example.test\' WHERE id=?').run(f.senderId), /immutable/);
  } finally { db.close(); }
});

test("new stage authority can start once and account deletion cascades retained execution graphs", async () => {
  const db = await legacy();
  try {
    await migrate(db); const f = fixture(db, "cascade"), m = membership(db, "cascade", f), a = action(db, "cascade", f, m.id);
    reason(db, "cascade", f, m.id, { kind: "STAGE", ...a.origin, actionExecutionId: a.id, stopOnStageExit: 1, stopOnGoal: 1 });
    const e = execution(db, "cascade", f, m.id, { authorizationKind: "STAGE", authorizationRequestKey: null, authorizationRequestDigest: null,
      authorizationActorId: null, authorizationReason: null, authorizationActionExecutionId: a.id });
    const message = send(db, "cascade", f, m.id);
    db.prepare('UPDATE "CampaignStepExecution" SET "sendId"=?,status=\'SEND_PENDING\' WHERE id=?').run(message.id, e.id);
    db.prepare('UPDATE "EmailSender" SET "refreshMembershipId"=? WHERE id=?').run(m.id, f.senderId);
    assert.throws(() => db.exec('DELETE FROM "CampaignStepExecution"'), /retained/);
    db.prepare('DELETE FROM "User" WHERE id=?').run(f.scope.ownerId);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM "FunnelActionExecution"').get()?.n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM "CampaignStepExecution"').get()?.n, 0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test("event deadline equality, unrelated subjects and changed source generations cannot release a wait", async () => {
  for (const variant of ["occurrence-boundary", "availability-boundary", "other-subject", "changed-generation"] as const) {
    const db = await legacy();
    try {
      await migrate(db);
      const f = fixture(db, variant, "owner-a", "TEST", "SUBJECT", JSON.stringify({ kind: "EVENT", sourceId: `source-${variant}`,
        type: "email.delivered", anchor: "ENROLLED", timeoutSeconds: 86400, onTimeout: "SKIP_STEP" }));
      const m = membership(db, variant, f, { startedAt: now });
      const subjectId = variant === "other-subject" ? "unrelated-subject" : f.subjectId;
      if (subjectId !== f.subjectId) insert(db, "FunnelSubject", { id: subjectId, ...f.scope, kind: "SALES", contactId: f.contactId });
      insert(db, "TrackingEvent", { id: "edge-event", ...f.scope, sourceId: f.sourceId, sourceGeneration: 1, type: "email.delivered", dedupeKey: variant,
        rawPayloadDigest: variant, envelope: "{}", status: "MATCHED", subjectId, matchRevision: 1,
        occurredAt: variant === "occurrence-boundary" ? later : now, expiresAt: later });
      const availableAt = variant === "availability-boundary" ? later : now;
      insert(db, "FunnelEvaluationReceipt", { id: "edge-receipt", ...f.scope, eventId: "edge-event", subjectId, matchRevision: 1,
        sourceGeneration: 1, mode: "LIVE", createdAt: availableAt });
      const e = execution(db, variant, f, m.id, { status: "WAITING", dueAt: null, expiresAt: null, resolvedAt: null,
        waitSourceId: f.sourceId, sourceGeneration: 1, waitDeadlineAt: later });
      if (variant === "changed-generation") db.prepare('UPDATE "TrackingSource" SET generation=2 WHERE id=?').run(f.sourceId);
      assert.throws(() => db.prepare('UPDATE "CampaignStepExecution" SET "receiptId"=\'edge-receipt\',"eventId"=\'edge-event\',"matchRevision"=1,"evidenceAvailableAt"=? WHERE id=?')
        .run(availableAt, e.id), /original timely LIVE/, variant);
    } finally { db.close(); }
  }
});

test("a resolved timeout cannot be backfilled with valid evidence and a captured action cannot reset its clock", async () => {
  const db = await legacy();
  try {
    await migrate(db);
    const f = fixture(db, "timeout", "owner-a", "TEST", "SUBJECT", JSON.stringify({ kind: "EVENT", sourceId: "source-timeout",
      type: "email.delivered", anchor: "ENROLLED", timeoutSeconds: 86400, onTimeout: "SKIP_STEP" }));
    const m = membership(db, "timeout", f, { startedAt: now }), ev = eventFixture(db, "timeout", f);
    const e = execution(db, "timeout", f, m.id, { status: "WAITING", dueAt: null, expiresAt: null, resolvedAt: null,
      waitSourceId: f.sourceId, sourceGeneration: 1, waitDeadlineAt: later });
    db.prepare('UPDATE "CampaignStepExecution" SET status=\'SKIPPED\',"completedAt"=?,"resolvedAt"=? WHERE id=?').run(later, later, e.id);
    assert.throws(() => db.prepare('UPDATE "CampaignStepExecution" SET "receiptId"=?,"eventId"=?,"matchRevision"=1,"evidenceAvailableAt"=? WHERE id=?')
      .run(ev.receiptId, ev.eventId, ev.evidenceAvailableAt, e.id), /immutable/);
    const a = action(db, "timeout", f, m.id);
    const { origin: _origin, plan, ...copy } = a;
    assert.throws(() => insert(db, "FunnelActionExecution", { ...copy, id: "shifted-action", plan: JSON.stringify(plan), dueAt: later,
      expiresAt: "2026-10-19T12:00:00.000Z" }), /captured transition/);
    const secondOwner = fixture(db, "environment", "owner-a", "LIVE"), other = membership(db, "environment", secondOwner);
    assert.throws(() => execution(db, "wrong-environment", { ...f, revisionId: secondOwner.revisionId, stepId: secondOwner.stepId }, other.id), /FOREIGN KEY/);
  } finally { db.close(); }
});

test("stop evidence captures immutable owned cause, stage, journey revision and occurrence", async () => {
  const db = await legacy();
  try {
    await migrate(db); const f = fixture(db, "stop-proof"), origin = journey(db, "stop-proof", f.scope, f.subjectId);
    const evidence = eventFixture(db, "stop-proof", f), other = fixture(db, "stop-other", "owner-b"), otherEvidence = eventFixture(db, "stop-other", other);
    const values = { id: "stop-proof", ...f.scope, funnelId: "funnel-stop-proof", versionId: origin.versionId,
      subjectId: f.subjectId, journeyId: origin.journeyId, evidenceKey: "event:stop-proof", outcome: "UNKNOWN_CONDITION", ruleId: "stop",
      evaluationEventId: evidence.eventId, evaluatedStageKey: "welcome", evaluationJourneyRevision: 1, evaluationOccurredAt: now };
    assert.throws(() => insert(db, "FunnelEvidenceEffect", { ...values, evaluationEventId: otherEvidence.eventId }), /owned subject/);
    assert.throws(() => insert(db, "FunnelEvidenceEffect", { ...values, evaluationOccurredAt: later }), /immutable occurrence/);
    assert.throws(() => insert(db, "FunnelEvidenceEffect", { ...values, evaluationJourneyRevision: 0 }), /CHECK/);
    assert.throws(() => insert(db, "FunnelEvidenceEffect", { ...values, evaluatedStageKey: null }), /CHECK/);
    assert.throws(() => insert(db, "FunnelEvidenceEffect", { ...values, evaluatedStageKey: "unpublished-stage" }), /FOREIGN KEY/);
    insert(db, "FunnelEvidenceEffect", values);
    for (const column of ["evaluationEventId", "evaluatedStageKey", "evaluationJourneyRevision", "evaluationOccurredAt"]) {
      assert.throws(() => db.exec(`UPDATE "FunnelEvidenceEffect" SET "${column}"=NULL`), /immutable/);
    }
    db.exec('UPDATE "FunnelJourney" SET revision=2');
    assert.equal(db.prepare('SELECT "evaluationJourneyRevision" FROM "FunnelEvidenceEffect"').get()?.evaluationJourneyRevision, 1);
    db.prepare('DELETE FROM "User" WHERE id=?').run(f.scope.ownerId);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM "FunnelEvidenceEffect"').get()?.n, 0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});
