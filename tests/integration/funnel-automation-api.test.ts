import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createEmailFixture, EMAIL_FIXTURE_ORIGIN } from "../support/email-fixture";
import { createEmailApi } from "../../apps/web/src/server/email/emailApi";
import { createFunnelApi } from "../../apps/web/src/server/funnels/funnelApi";
import { validateDefinition, type FunnelDefinition, type FunnelStageAction } from "../../apps/web/src/server/funnels/funnelDefinition";

const request = (path: string, method: string, cookie?: string, body?: unknown, origin: string | null = EMAIL_FIXTURE_ORIGIN) => new Request(`${EMAIL_FIXTURE_ORIGIN}${path}`, {
  method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
async function result(response: Response, status: number, code?: string) {
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  assert.equal(response.headers.get("cache-control"), "no-store");
  if (code) assert.equal(value.code, code);
  return value;
}
const basic = (): FunnelDefinition => ({ schemaVersion: 1, stages: [{ id: "lead", name: "Lead", goal: false, terminal: "NONE" }], entryStages: ["lead"], routes: [] });
const enroll = (campaignId: string, revisionId: string): Extract<FunnelStageAction, { kind: "EMAIL_ENROLL" }> => ({ id: "nurture", stageId: "lead", kind: "EMAIL_ENROLL", campaignId, revisionId,
  delaySeconds: 60, expiresAfterDueSeconds: 120, stopOnStageExit: true, stopOnGoal: true });

test("funnel automation controls and journey cancellation require exact Origin, current session and owned records", async () => {
  const f = await createEmailFixture();
  try {
    const item = await f.enrolled(), stranger = await f.owner(), api = createFunnelApi(f.auth, f.funnels);
    const controls = `/api/funnels/${item.funnel!.id}/controls`, cancel = `/api/funnels/${item.funnel!.id}/journeys/${item.journey!.id}/cancel`;
    const calls = [{ path: controls, method: "PATCH", body: { automationEnrolmentEnabled: true, automationDispatchEnabled: true } },
      { path: cancel, method: "POST", body: { reason: "Customer requested a stop" } }];
    for (const call of calls) {
      await result(await api(request(call.path, call.method, undefined, call.body)), 401);
      for (const origin of [null, "https://foreign.example", `${EMAIL_FIXTURE_ORIGIN}/`, "http://launchpad.test"])
        await result(await api(request(call.path, call.method, f.cookie, call.body, origin)), 403, "INVALID_ORIGIN");
      await result(await api(request(call.path, call.method, stranger.cookie, call.body)), 404, "NOT_FOUND");
    }
    const initial = await f.funnels.get(f.principal, item.funnel!.id);
    assert.equal(initial.automationEnrolmentEnabled, false); assert.equal(initial.automationDispatchEnabled, false);
    assert.equal((await f.funnels.history(f.principal, item.funnel!.id, item.journey!.id)).journey.status, "ACTIVE");
    await result(await api(request(controls, "PATCH", f.cookie, { automationDispatchEnabled: "true" })), 400, "INVALID_FUNNEL_INPUT");
    await result(await api(request(cancel, "POST", f.cookie, { reason: "" })), 400);
    const another = await f.funnels.create(f.principal, { name: "Separate funnel", environment: "TEST", subjectKind: "SALES", definition: basic() });
    await result(await api(request(`/api/funnels/${another.id}/controls`, "PATCH", f.cookie, { automationEnrolmentEnabled: true })), 409, "FUNNEL_UNPUBLISHED");
    await result(await api(request(`/api/funnels/${another.id}/journeys/${item.journey!.id}/cancel`, "POST", f.cookie, { reason: "Wrong funnel" })), 404, "NOT_FOUND");
    const enabled = await result(await api(request(controls, "PATCH", f.cookie, calls[0].body)), 200);
    assert.equal(enabled.automationEnrolmentEnabled, true); assert.equal(enabled.automationDispatchEnabled, true);
    const cancelled = await result(await api(request(cancel, "POST", f.cookie, calls[1].body)), 200);
    assert.equal(cancelled.journey.status, "CANCELLED");
    const audit = cancelled.transitions.filter((entry: { reasonCode: string }) => entry.reasonCode === "JOURNEY_CANCELLED");
    assert.equal(audit.length, 1); assert.equal(audit[0].actorId, f.principal.userId); assert.equal(audit[0].note, calls[1].body.reason);
    const repeated = await result(await api(request(cancel, "POST", f.cookie, calls[1].body)), 200);
    assert.equal(repeated.transitions.length, cancelled.transitions.length);
    assert.equal((await f.campaigns.membership(f.principal, item.membership.id)).membership.status, "ACTIVE", "A manual campaign reason is independent of the cancelled journey");
    await f.db.customerSession.update({ where: { id: f.principal.sessionId }, data: { expiresAt: f.now() } });
    for (const call of calls) await result(await api(request(call.path, call.method, f.cookie, call.body)), 401);
    assert.equal(f.requests.filter(entry => entry.method === "POST").length, 0);
  } finally { await f.close(); }
});

test("HTTP start arms a timed sequence once while paused, records provenance and cannot bypass the wait", async () => {
  const f = await createEmailFixture();
  try {
    const setup = await f.readyConnection(), definition = f.definition(setup.sender.id);
    definition.steps[0].wait = { kind: "DURATION", seconds: 3600 };
    definition.steps.push({ ...definition.steps[0], id: "follow-up", wait: { kind: "IMMEDIATE" } });
    const item = await f.enrolled({ published: await f.publishedCampaign({ setup, definition }), journey: false }), stranger = await f.owner();
    const api = createEmailApi(f.auth, f.connections, f.campaigns, f.delivery), path = `/api/email/memberships/${item.membership.id}`;
    const command = { requestKey: randomUUID(), reason: "Start the reviewed two-message sequence" };
    await result(await api(request(`${path}/start`, "POST", undefined, command)), 401);
    await result(await api(request(`${path}/start`, "POST", f.cookie, command, null)), 403, "INVALID_ORIGIN");
    await result(await api(request(`${path}/start`, "POST", stranger.cookie, command)), 404, "NOT_FOUND");
    await result(await api(request(`${path}/dispatch`, "POST", f.cookie, {})), 409, "EMAIL_STEP_UNAVAILABLE");
    assert.equal(await f.db.campaignStepExecution.count(), 0);
    await f.campaigns.controls(f.principal, item.campaign.id, { dispatchEnabled: false });
    f.setNow(new Date("2026-10-19T10:20:00Z"));
    const requestsBefore = f.requests.length;
    const started = await result(await api(request(`${path}/start`, "POST", f.cookie, command)), 200);
    const replay = await result(await api(request(`${path}/start`, "POST", f.cookie, command)), 200);
    assert.equal(started.existing, false); assert.equal(replay.existing, true); assert.equal(replay.executionId, started.executionId);
    await result(await api(request(`${path}/start`, "POST", f.cookie, { ...command, reason: "Different request" })), 409, "IDEMPOTENCY_CONFLICT");
    await result(await api(request(`${path}/start`, "POST", f.cookie, { ...command, requestKey: randomUUID() })), 409, "CADENCE_ALREADY_STARTED");
    await result(await api(request(`${path}/dispatch`, "POST", f.cookie, {})), 409, "STEP_WAITING");
    const history = await result(await api(request(path, "GET", f.cookie)), 200);
    assert.equal(history.cadenceStarted, true); assert.equal(history.steps.length, 1);
    assert.equal(history.steps[0].authorizationKind, "MANUAL"); assert.equal(history.steps[0].authorizationActorId, f.principal.userId);
    assert.equal(history.steps[0].authorizationReason, command.reason); assert.equal(history.steps[0].dueAt, "2026-10-19T11:00:00.000Z");
    assert.equal(history.sends.length, 0); assert.equal(f.requests.length, requestsBefore);
    await f.db.customerSession.delete({ where: { id: f.principal.sessionId } });
    await result(await api(request(`${path}/start`, "POST", f.cookie, command)), 401);
  } finally { await f.close(); }
});

test("stage actions accept only implemented, bounded, unambiguous email contracts", () => {
  const action = enroll("campaign", "revision"), source = { ...basic(), stageActions: [action] };
  assert.deepEqual(validateDefinition(source).stageActions, [action]);
  const unsupported = [
    { ...action, kind: "SMS_SEND" }, { ...action, kind: "WEBHOOK" }, { ...action, stageId: "absent" },
    { ...action, revisionId: "" }, { ...action, delaySeconds: -1 }, { ...action, delaySeconds: 0.5 },
    { ...action, expiresAfterDueSeconds: 0 }, { ...action, delaySeconds: 31536001 }, { ...action, stopOnGoal: "false" },
    { id: "stop", stageId: "lead", kind: "EMAIL_STOP", campaignId: "campaign", revisionId: "revision" },
  ];
  for (const invalid of unsupported) assert.throws(() => validateDefinition({ ...source, stageActions: [invalid] }), { code: "INVALID_FUNNEL_DEFINITION" });
  for (const duplicate of [{ ...action }, { ...action, id: "second-same-campaign" }, { ...action, campaignId: "another-campaign" }])
    assert.throws(() => validateDefinition({ ...source, stageActions: [action, duplicate] }), { code: "INVALID_FUNNEL_DEFINITION" });
  const defaults = validateDefinition({ ...source, stageActions: [{ id: "default", stageId: "lead", kind: "EMAIL_ENROLL", campaignId: "campaign", revisionId: "revision" }] }).stageActions![0];
  assert.deepEqual(defaults, { ...action, id: "default", delaySeconds: 0, expiresAfterDueSeconds: 604800 });
  assert.deepEqual(validateDefinition({ ...source, stageActions: [{ id: "stop", stageId: "lead", kind: "EMAIL_STOP", campaignId: "campaign" }] }).stageActions,
    [{ id: "stop", stageId: "lead", kind: "EMAIL_STOP", campaignId: "campaign" }]);
});

test("publication checks campaign owner, environment, email capability and exact pinned revision", async () => {
  const f = await createEmailFixture();
  try {
    const published = await f.publishedCampaign(), another = await f.publishedCampaign(), stranger = await f.owner();
    const foreign = await f.publishedCampaign({ principal: stranger.principal });
    const social = await f.campaigns.create(f.principal, { name: "Social only", category: "SOCIAL", environment: "TEST" });
    const unpublished = await f.campaigns.create(f.principal, { name: "Draft email", environment: "TEST", definition: published.definition });
    const api = createFunnelApi(f.auth, f.funnels);
    const publishAction = async (action: FunnelStageAction, environment = "TEST") => {
      const draft = await f.funnels.create(f.principal, { name: "Action publication", environment, subjectKind: "SALES", definition: { ...basic(), stageActions: [action] } });
      return api(request(`/api/funnels/${draft.id}/publish`, "POST", f.cookie, { draftRevision: 1 }));
    };
    for (const target of [foreign, { campaign: social, revision: published.revision }, { campaign: unpublished, revision: published.revision }])
      await result(await publishAction(enroll(target.campaign.id, target.revision.id)), 409, "FUNNEL_CAMPAIGN_UNAVAILABLE");
    await result(await publishAction(enroll(published.campaign.id, published.revision.id), "LIVE"), 409, "FUNNEL_CAMPAIGN_UNAVAILABLE");
    await result(await publishAction(enroll(published.campaign.id, another.revision.id)), 409, "FUNNEL_CAMPAIGN_REVISION_UNAVAILABLE");
    await result(await publishAction(enroll(published.campaign.id, randomUUID())), 409, "FUNNEL_CAMPAIGN_REVISION_UNAVAILABLE");
    const revised = structuredClone(published.definition); revised.steps[0].subject = "New campaign revision";
    const update = await f.campaigns.updateDraft(f.principal, published.campaign.id, { draftRevision: 1, definition: revised });
    const newPublication = await f.campaigns.publish(f.principal, published.campaign.id, { draftRevision: update.draftRevision });
    assert.notEqual(newPublication.revision.id, published.revision.id);
    const pinned = await result(await publishAction(enroll(published.campaign.id, published.revision.id)), 200);
    assert.equal(pinned.version.definition.stageActions[0].revisionId, published.revision.id);
    await f.campaigns.controls(f.principal, published.campaign.id, { status: "ARCHIVED" });
    await result(await publishAction({ id: "stop", stageId: "lead", kind: "EMAIL_STOP", campaignId: published.campaign.id }), 409, "FUNNEL_CAMPAIGN_UNAVAILABLE");
    assert.equal(await f.db.campaignMembership.count(), 0); assert.equal(await f.db.funnelActionExecution.count(), 0);
  } finally { await f.close(); }
});

function simulationDefinition(): FunnelDefinition {
  const route = (id: string, from: string | null, to: string) => ({ id, from, trigger: { kind: "EVENT" as const, sourceId: "sample-source", type: `custom.${to}` }, branches: [], fallback: { kind: "MOVE" as const, to } });
  return { schemaVersion: 1, stages: [{ id: "lead", name: "Lead", goal: false, terminal: "NONE" }, { id: "engaged", name: "Engaged", goal: false, terminal: "NONE" },
    { id: "booked", name: "Booked", goal: true, terminal: "SUCCESS" }], entryStages: ["lead"], routes: [route("enter", null, "lead"), route("engage", "lead", "engaged"), route("book", "engaged", "booked")],
    stageActions: [{ ...enroll("campaign-a", "revision-a"), stopOnStageExit: false, stopOnGoal: false },
      { id: "stop-a", stageId: "engaged", kind: "EMAIL_STOP", campaignId: "campaign-a" },
      { ...enroll("campaign-b", "revision-b"), id: "follow-up", stageId: "engaged" },
      { ...enroll("campaign-c", "revision-c"), id: "goal-action", stageId: "booked" }] };
}

test("funnel HTTP simulation plans delayed actions, explicit stops and goal cancellation with zero writes or provider calls", async () => {
  const f = await createEmailFixture();
  try {
    const definition = simulationDefinition(), funnel = await f.funnels.create(f.principal, { name: "Preview only", environment: "TEST", subjectKind: "SALES", definition });
    const api = createFunnelApi(f.auth, f.funnels), path = `/api/funnels/${funnel.id}/simulate`, stranger = await f.owner();
    const events = ["lead", "engaged", "booked"].map((stage, index) => ({ sourceId: "sample-source", type: `custom.${stage}`, properties: {},
      occurredAt: `2026-10-19T10:0${index}:00Z`, recordedAt: `2026-10-19T10:0${index + 1}:00Z` }));
    const before = await f.db.$queryRawUnsafe("SELECT total_changes() AS changes"), requestsBefore = f.requests.length;
    await result(await api(request(path, "POST", undefined, { events })), 401);
    await result(await api(request(path, "POST", f.cookie, { events }, null)), 403, "INVALID_ORIGIN");
    await result(await api(request(path, "POST", stranger.cookie, { events })), 404, "NOT_FOUND");
    const preview = await result(await api(request(path, "POST", f.cookie, { events, automationEnrolmentEnabled: true })), 200);
    assert.equal(preview.simulated, true); assert.equal(preview.externalEffects, false); assert.equal(preview.currentStage, "booked");
    assert.equal(preview.history[0].actions[0].dueAt, "2026-10-19T10:02:00.000Z");
    assert.equal(preview.history[0].actions[0].expiresAt, "2026-10-19T10:04:00.000Z");
    assert.deepEqual(preview.history[1].stops, [{ actionId: "nurture", reason: "STAGE_STOP_ACTION" }]);
    assert.deepEqual(preview.history[2].stops, [{ actionId: "follow-up", reason: "GOAL_REACHED" }]);
    assert.equal(preview.history[2].actions[0].status, "CANCELLED"); assert.equal(preview.history[2].actions[0].reason, "GOAL_REACHED");
    assert.ok(preview.history.every((row: { externalEffects: boolean }) => row.externalEffects === false));
    const paused = await result(await api(request(path, "POST", f.cookie, { events })), 200);
    assert.deepEqual(paused.history[0].actions, []); assert.deepEqual(paused.history[2].actions, []);
    assert.equal(paused.history[1].actions.length, 1); assert.equal(paused.history[1].actions[0].kind, "EMAIL_STOP");
    assert.deepEqual(await f.db.$queryRawUnsafe("SELECT total_changes() AS changes"), before);
    assert.equal(f.requests.length, requestsBefore); assert.equal(await f.db.funnelJourney.count(), 0);
    assert.equal(await f.db.funnelActionExecution.count(), 0); assert.equal(await f.db.campaignMembership.count(), 0); assert.equal(await f.db.messageSend.count(), 0);
  } finally { await f.close(); }
});

test("replay and backfill previews cannot enroll, but can retain explicit stop and stage-exit consequences", async () => {
  const f = await createEmailFixture();
  try {
    const definition = simulationDefinition(), funnel = await f.funnels.create(f.principal, { name: "Historical preview", environment: "TEST", subjectKind: "SALES", definition });
    const entry = { sourceId: "sample-source", type: "custom.lead", properties: {}, occurredAt: "2026-10-19T10:00:00Z", evidenceKey: "same-occurrence" };
    for (const mode of ["REPLAY", "BACKFILL"]) {
      const noEntry = await f.funnels.simulate(f.principal, funnel.id, { automationEnrolmentEnabled: true, events: [{ ...entry, mode }] });
      assert.equal(noEntry.currentStage, null);
      const first = noEntry.history[0] as { reason: string; actions: unknown[] };
      assert.equal(first.reason, "HISTORY_ONLY_NO_ENTRY"); assert.deepEqual(first.actions, []);
      const result = await f.funnels.simulate(f.principal, funnel.id, { automationEnrolmentEnabled: true, events: [entry,
        { ...entry, evidenceKey: "engaged", type: "custom.engaged", occurredAt: "2026-10-19T10:01:00Z", mode }] });
      const second = result.history[1] as { actions: { kind: string }[]; stops: unknown[] };
      assert.deepEqual(second.actions.map(action => action.kind), ["EMAIL_STOP"]);
      assert.deepEqual(second.stops, [{ actionId: "nurture", reason: "STAGE_STOP_ACTION" }]);
    }
    const exit = structuredClone(definition); exit.stageActions![0] = enroll("campaign-a", "revision-a");
    const exited = await f.funnels.simulate(f.principal, funnel.id, { definition: exit, automationEnrolmentEnabled: true, events: [entry,
      { ...entry, evidenceKey: "engaged", type: "custom.engaged", occurredAt: "2026-10-19T10:01:00Z", mode: "REPLAY" }] });
    assert.deepEqual((exited.history[1] as { stops: unknown[] }).stops, [{ actionId: "nurture", reason: "STAGE_EXITED" }]);
    const duplicate = await f.funnels.simulate(f.principal, funnel.id, { automationEnrolmentEnabled: true, events: [entry, { ...entry, mode: "REPLAY" }] });
    assert.equal((duplicate.history[1] as { reason: string }).reason, "DUPLICATE_EVIDENCE");
    assert.deepEqual((duplicate.history[1] as { actions: unknown[] }).actions, []);
    assert.equal(await f.db.funnelActionOutbox.count(), 0); assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test("simulation remembers a prior goal and an initial goal when planning actions on later non-goal stages", async () => {
  const f = await createEmailFixture();
  try {
    const definition = simulationDefinition();
    definition.stages.find(stage => stage.id === "booked")!.terminal = "NONE";
    definition.stages.push({ id: "after-goal", name: "Post-booking", goal: false, terminal: "NONE" });
    definition.routes.push({ id: "continue", from: "booked", trigger: { kind: "EVENT", sourceId: "sample-source", type: "custom.continue" },
      branches: [], fallback: { kind: "MOVE", to: "after-goal" } });
    definition.stageActions!.push({ ...enroll("campaign-after-goal", "revision-after-goal"), id: "stop-after-goal", stageId: "after-goal" },
      { ...enroll("campaign-retained", "revision-retained"), id: "allow-after-goal", stageId: "after-goal", stopOnGoal: false });
    const funnel = await f.funnels.create(f.principal, { name: "Post-goal preview", environment: "TEST", subjectKind: "SALES", definition });
    const api = createFunnelApi(f.auth, f.funnels), path = `/api/funnels/${funnel.id}/simulate`;
    const events = ["lead", "engaged", "booked", "continue"].map((stage, index) => ({ sourceId: "sample-source", type: `custom.${stage}`,
      properties: {}, occurredAt: `2026-10-19T10:0${index}:00Z` }));
    const before = await f.db.$queryRawUnsafe("SELECT total_changes() AS changes");
    const samples = [
      { events },
      { currentStage: "booked", events: [events[3]] },
      { events: events.map((event, index) => index === 2 ? { ...event, mode: "REPLAY" } : event) },
    ];
    for (const sample of samples) {
      const preview = await result(await api(request(path, "POST", f.cookie, { ...sample, automationEnrolmentEnabled: true })), 200);
      assert.equal(preview.currentStage, "after-goal");
      const actions = preview.history.at(-1).actions;
      assert.equal(actions[0].id, "stop-after-goal"); assert.equal(actions[0].status, "CANCELLED"); assert.equal(actions[0].reason, "GOAL_REACHED");
      assert.equal(actions[1].id, "allow-after-goal"); assert.equal(actions[1].status, "PLANNED");
    }
    assert.deepEqual(await f.db.$queryRawUnsafe("SELECT total_changes() AS changes"), before);
    assert.equal(f.requests.length, 0); assert.equal(await f.db.funnelActionExecution.count(), 0);
  } finally { await f.close(); }
});
