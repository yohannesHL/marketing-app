import assert from "node:assert/strict";
import test from "node:test";
import { addStage, conditionNodes, connectStages, connectionIssue, funnelEdges, moveStage, parseConditionScalar, removeStage } from "../../apps/web/src/components/funnels/funnelGraph";
import { evaluateFunnel, validateCondition, validateDefinition, type Condition, type FunnelDefinition } from "../../apps/web/src/server/funnels/funnelDefinition";

function definition(): FunnelDefinition {
  return validateDefinition({ schemaVersion: 1, stages: [
    { id: "enquiry", name: "Custom consultation received", goal: false, terminal: "NONE" },
    { id: "qualified", name: "Needs a bespoke proposal", goal: true, terminal: "NONE" },
    { id: "won", name: "Agreement completed", goal: true, terminal: "SUCCESS" },
  ], entryStages: ["enquiry"], routes: [
    { id: "entry", from: null, trigger: { kind: "EVENT", sourceId: "crm", type: "enquiry.accepted" }, branches: [], fallback: { kind: "MOVE", to: "enquiry" } },
    { id: "qualify", from: "enquiry", trigger: { kind: "EVENT", sourceId: "crm", type: "custom.qualified" }, branches: [
      { id: "valuable", to: "qualified", when: { field: { scope: "EVENT", key: "amount" }, type: "decimal", op: "gte", value: "1000.00" } },
      { id: "otherwise", to: "won" },
    ], fallback: { kind: "WAIT" } },
    { id: "close", from: "qualified", trigger: { kind: "EVENT", sourceId: "crm", type: "deal.won" }, branches: [], fallback: { kind: "MOVE", to: "won" } },
  ], campaignLinks: [{ id: "attribution", stageId: "qualified", campaignId: "social-campaign", purpose: "ATTRIBUTION" }],
  stageActions: [{ id: "email-action", stageId: "qualified", campaignId: "email-campaign", kind: "EMAIL_ENROLL", revisionId: "pinned-revision",
    delaySeconds: 3600, expiresAfterDueSeconds: 86400, stopOnStageExit: true, stopOnGoal: false }] });
}

test("canvas projection preserves distinct ordered branches, entry and fallback identity", () => {
  const source = definition(), before = structuredClone(source), edges = funnelEdges(source);
  assert.deepEqual(edges.map(edge => [edge.from, edge.to, edge.routeId, edge.branchId, edge.kind]), [
    [null, "enquiry", "entry", undefined, "FALLBACK"], ["enquiry", "qualified", "qualify", "valuable", "BRANCH"],
    ["enquiry", "won", "qualify", "otherwise", "BRANCH"], ["qualified", "won", "close", undefined, "FALLBACK"],
  ]);
  assert.equal(new Set(edges.map(edge => edge.id)).size, edges.length);
  assert.match(edges[1].label, /Branch 1/); assert.match(edges[2].label, /Branch 2.*Always/);
  assert.deepEqual(source, before);
});

test("renaming and rearranging custom stages preserve rule priority, pinned actions and UNKNOWN behavior", () => {
  const source = definition(), renamed = { ...source, stages: source.stages.map(stage => stage.id === "qualified" ? { ...stage, name: "Ready for an individual proposal" } : stage) };
  const moved = moveStage(renamed, "qualified", -1);
  assert.equal(moved.stages[0].id, "qualified"); assert.equal(moved.stages[0].name, "Ready for an individual proposal");
  assert.deepEqual(moved.routes, source.routes); assert.deepEqual(moved.stageActions, source.stageActions); assert.deepEqual(moved.campaignLinks, source.campaignLinks);
  validateDefinition(moved);
  const input = { currentStage: "enquiry", event: { sourceId: "crm", type: "custom.qualified", occurredAt: "2026-10-19T10:00:00Z", properties: { amount: "1000.0001" } }, properties: {}, changedFields: [] };
  assert.equal(evaluateFunnel(moved, input).to, "qualified"); assert.deepEqual(evaluateFunnel(moved, input), evaluateFunnel(source, input));
  assert.equal(evaluateFunnel(moved, { ...input, event: { ...input.event, properties: {} } }).outcome, "UNKNOWN");
  assert.equal(source.stages[0].id, "enquiry");
});

test("new connections require an explicit source and event and reject terminal, entry and cycle violations", () => {
  const source = definition();
  assert.match(connectionIssue(source, "won", "enquiry")!, /exit stage/i);
  assert.match(connectionIssue(source, "qualified", "enquiry")!, /cycle/i);
  assert.match(connectionIssue(source, "enquiry", "enquiry")!, /itself/);
  assert.match(connectionIssue(source, null, "qualified")!, /entry/i);
  assert.match(connectionIssue(source, "missing", "enquiry")!, /starting stage/);
  assert.match(connectionIssue(source, "enquiry", "missing")!, /destination/);
  assert.equal(connectionIssue(source, null, "enquiry"), null);
  const extended = addStage(source, { id: "review", name: "Our own review milestone" }, "qualified");
  assert.deepEqual(extended.stages.map(stage => stage.id), ["enquiry", "qualified", "review", "won"]);
  assert.throws(() => connectStages(extended, { id: "review-rule", from: "qualified", to: "review", sourceId: "", type: "custom.review" }), /source and event/);
  const connected = connectStages(extended, { id: "review-rule", from: "qualified", to: "review", sourceId: "review-source", type: "custom.review" });
  assert.deepEqual(connected.routes.at(-1), { id: "review-rule", from: "qualified", trigger: { kind: "EVENT", sourceId: "review-source", type: "custom.review" }, branches: [], fallback: { kind: "MOVE", to: "review" } });
  assert.deepEqual(connected.stageActions, source.stageActions); assert.equal(extended.routes.length, source.routes.length);
  assert.match(connectionIssue(connected, "review", "enquiry")!, /cycle/);
  const first = addStage({ schemaVersion: 1, stages: [], entryStages: [], routes: [] }, { id: "start", name: "Start here" });
  assert.deepEqual(first.entryStages, ["start"]); assert.deepEqual(first.routes, []);
});

test("removing a stage cleans references without retargeting routes or activating campaign links", () => {
  const source = definition(), before = structuredClone(source), removed = removeStage(source, "qualified");
  const validated = validateDefinition(removed);
  assert.deepEqual(validated.stages.map(stage => stage.id), ["enquiry", "won"]);
  assert.deepEqual(validated.routes.map(route => route.id), ["entry", "qualify"]);
  assert.deepEqual(validated.routes[1].branches, [source.routes[1].branches[1]]);
  assert.deepEqual(validated.campaignLinks, []); assert.deepEqual(validated.stageActions, []);
  const withoutEntry = removeStage(source, "enquiry"); validateDefinition(withoutEntry);
  assert.deepEqual(withoutEntry.entryStages, []); assert.deepEqual(withoutEntry.routes[0].fallback, { kind: "WAIT" });
  assert.deepEqual(source, before);
});

test("typed editor values preserve exact decimals and timestamps and never coerce empty or malformed input", () => {
  for (const value of ["9007199254740993.000000001", "-0.000000000000000001", "0019.9500"]) assert.deepEqual(parseConditionScalar(value, "decimal"), { value });
  for (const value of ["2026-10-25T01:30:00+01:00", "2026-10-25T01:30:00+00:00", "2026-10-19T10:00:00.123456789Z"])
    assert.deepEqual(parseConditionScalar(value, "datetime"), { value });
  for (const [raw, type] of [["", "number"], [" ", "number"], ["0x10", "number"], ["1e999", "number"], ["1.", "decimal"], ["1e3", "decimal"],
    ["2026-02-30T10:00:00Z", "datetime"], ["2026-10-19T10:00", "datetime"], ["yes", "boolean"]] as const) assert.ok(parseConditionScalar(raw, type).error);
  assert.deepEqual(parseConditionScalar("false", "boolean"), { value: false });
  assert.deepEqual(parseConditionScalar("-2.5e2", "number"), { value: -250 });
  assert.deepEqual(parseConditionScalar("a,b\nvalue", "string"), { value: "a,b\nvalue" }, "String list entries are not implicitly split");
  const exact = parseConditionScalar("9007199254740993.000000001", "decimal"); assert.ok(!exact.error);
  const condition: Condition = { all: [{ field: { scope: "EVENT", key: "amount" }, type: "decimal", op: "gte", value: exact.value },
    { any: [{ field: { scope: "EVENT", key: "approved" }, type: "boolean", op: "eq", value: false }, { field: { scope: "EVENT", key: "approval" }, type: "string", op: "isMissing" }] }] };
  assert.deepEqual(validateCondition(condition), condition); assert.equal(conditionNodes(condition), 5);
});
