import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateFunnel, fieldKey, validateDefinition, type Condition, type EvaluationInput, type FunnelDefinition } from "../../apps/web/src/server/funnels/funnelDefinition";

const event = { sourceId: "source-a", type: "enquiry.accepted", properties: {}, occurredAt: "2026-10-17T12:00:00.000Z" };
const input = (patch: Partial<EvaluationInput> = {}): EvaluationInput => ({ currentStage: null, event, properties: {}, changedFields: [], ...patch });
function definition(when?: Condition): FunnelDefinition {
  return {
    schemaVersion: 1,
    stages: [
      { id: "new", name: "A custom first stage", goal: false, terminal: "NONE" },
      { id: "qualified", name: "Qualified", goal: true, terminal: "NONE" },
      { id: "finished", name: "Finished", goal: false, terminal: "SUCCESS" },
    ],
    entryStages: ["new"],
    routes: [{ id: "entry", from: null, trigger: { kind: "EVENT", sourceId: "source-a", type: "enquiry.accepted" }, branches: [{ id: "accept", to: "new", ...(when ? { when } : {}) }], fallback: { kind: "WAIT" } }],
  };
}
test("custom stages enter only on the configured event and one cause moves only once", () => {
  const draft = definition();
  draft.routes.push({ id: "qualify", from: "new", trigger: { kind: "EVENT", sourceId: "source-a", type: "enquiry.accepted" }, branches: [{ id: "qualify-now", to: "qualified" }], fallback: { kind: "WAIT" } });
  const parsed = validateDefinition(draft);
  const entered = evaluateFunnel(parsed, input());
  assert.equal(entered.outcome, "MOVE");
  assert.equal(entered.to, "new");
  assert.equal(entered.ruleId, "entry");
  assert.equal(evaluateFunnel(parsed, input({ event: { ...event, type: "page.viewed" } })).outcome, "WAIT");
  assert.equal(evaluateFunnel(parsed, input({ event: { ...event, sourceId: "source-b" } })).outcome, "WAIT");
});

test("missing evidence is UNKNOWN while false, zero and empty text remain known values", () => {
  for (const [type, value] of [["boolean", false], ["number", 0], ["string", ""]] as const) {
    const predicate: Condition = { field: { scope: "EVENT", key: "answer" }, type, op: "eq", value };
    const parsed = validateDefinition(definition(predicate));
    assert.equal(evaluateFunnel(parsed, input()).outcome, "UNKNOWN");
    assert.equal(evaluateFunnel(parsed, input({ event: { ...event, properties: { answer: value } } })).outcome, "MOVE");
    assert.equal(evaluateFunnel(parsed, input({ event: { ...event, properties: { answer: null } } })).outcome, "UNKNOWN");
  }
});

test("all and any obey every three-valued truth-table combination, including nested groups", () => {
  const cases = [
    [true, true, "MOVE", "MOVE"], [true, false, "WAIT", "MOVE"], [true, undefined, "UNKNOWN", "MOVE"],
    [false, true, "WAIT", "MOVE"], [false, false, "WAIT", "WAIT"], [false, undefined, "WAIT", "UNKNOWN"],
    [undefined, true, "UNKNOWN", "MOVE"], [undefined, false, "WAIT", "UNKNOWN"], [undefined, undefined, "UNKNOWN", "UNKNOWN"],
  ] as const;
  const a: Condition = { field: { scope: "EVENT", key: "a" }, type: "boolean", op: "eq", value: true };
  const b: Condition = { field: { scope: "EVENT", key: "b" }, type: "boolean", op: "eq", value: true };
  for (const [left, right, allResult, anyResult] of cases) {
    const properties = { ...(left === undefined ? {} : { a: left }), ...(right === undefined ? {} : { b: right }) };
    assert.equal(evaluateFunnel(validateDefinition(definition({ all: [a, b] })), input({ event: { ...event, properties } })).outcome, allResult);
    assert.equal(evaluateFunnel(validateDefinition(definition({ any: [a, b] })), input({ event: { ...event, properties } })).outcome, anyResult);
    assert.equal(evaluateFunnel(validateDefinition(definition({ all: [{ any: [a, b] }] })), input({ event: { ...event, properties } })).outcome, anyResult);
  }
});

test("presence predicates distinguish absent, cleared and conflicting properties without coercion", () => {
  const field = { scope: "PROPERTY", sourceId: "crm", type: "custom.qualification", key: "qualified" } as const;
  const key = fieldKey(field);
  const cases = [
    [{}, "WAIT", "MOVE", "UNKNOWN"],
    [{ [key]: { state: "VALUE", value: null } }, "WAIT", "WAIT", "MOVE"],
    [{ [key]: { state: "VALUE", value: false } }, "MOVE", "WAIT", "WAIT"],
    [{ [key]: { state: "VALUE", value: 0 } }, "MOVE", "WAIT", "WAIT"],
    [{ [key]: { state: "VALUE", value: "" } }, "MOVE", "WAIT", "WAIT"],
    [{ [key]: { state: "UNKNOWN", reason: "CONFLICT" } }, "UNKNOWN", "UNKNOWN", "UNKNOWN"],
    [{ [key]: { state: "UNKNOWN", reason: "UNAVAILABLE" } }, "UNKNOWN", "UNKNOWN", "UNKNOWN"],
  ] as const;
  for (const [properties, known, missing, isNull] of cases) {
    for (const [op, expected] of [["isKnown", known], ["isMissing", missing], ["isNull", isNull]] as const) {
      const result = evaluateFunnel(validateDefinition(definition({ field, type: "boolean", op })), input({ properties }));
      assert.equal(result.outcome, expected);
    }
  }
  assert.equal(evaluateFunnel(validateDefinition(definition({ field, type: "boolean", op: "neq", value: true })), input()).outcome, "UNKNOWN");
  assert.notEqual(fieldKey({ sourceId: "a:b", type: "c", key: "d" }), fieldKey({ sourceId: "a", type: "b:c", key: "d" }));
});

test("typed comparisons preserve decimal precision and datetime instants", () => {
  const cases = [
    ["decimal", "gt", "900719925474099312345.0000000002", "900719925474099312345.0000000001", "MOVE"],
    ["decimal", "lt", "-0.0000000002", "-0.0000000001", "MOVE"],
    ["decimal", "eq", "0001.2000", "1.2", "MOVE"],
    ["decimal", "gte", "0", "-0.00", "MOVE"],
    ["number", "gte", 0, 0, "MOVE"],
    ["number", "lte", 2, 1, "WAIT"],
    ["number", "eq", "2", 2, "UNKNOWN"],
    ["string", "eq", "CA", "ca", "WAIT"],
    ["datetime", "eq", "2026-10-17T13:00:00+01:00", "2026-10-17T12:00:00Z", "MOVE"],
    ["datetime", "gt", "2026-10-17T12:00:00.000000002Z", "2026-10-17T12:00:00.000000001Z", "MOVE"],
    ["datetime", "eq", "2026-02-30T00:00:00Z", "2026-03-02T00:00:00Z", "UNKNOWN"],
  ] as const;
  for (const [type, op, actual, value, outcome] of cases) {
    const parsed = validateDefinition(definition({ field: { scope: "EVENT", key: "value" }, type, op, value }));
    assert.equal(evaluateFunnel(parsed, input({ event: { ...event, properties: { value: actual } } })).outcome, outcome);
  }
  const inside = validateDefinition(definition({ field: { scope: "EVENT", key: "value" }, type: "decimal", op: "in", value: ["1.20", "2"] }));
  assert.equal(evaluateFunnel(inside, input({ event: { ...event, properties: { value: "1.2" } } })).outcome, "MOVE");
});

test("ordered branches stop at unknown, select the first true branch and use fallback only after false guards", () => {
  const condition: Condition = { field: { scope: "EVENT", key: "eligible" }, type: "boolean", op: "eq", value: true };
  const draft = definition(condition); draft.entryStages.push("qualified", "finished");
  draft.routes[0].branches.push({ id: "second", to: "qualified" });
  draft.routes[0].fallback = { kind: "MOVE", to: "finished" };
  const parsed = validateDefinition(draft);
  assert.equal(evaluateFunnel(parsed, input()).outcome, "UNKNOWN");
  assert.equal(evaluateFunnel(parsed, input({ event: { ...event, properties: { eligible: true } } })).to, "new");
  assert.equal(evaluateFunnel(parsed, input({ event: { ...event, properties: { eligible: false } } })).to, "qualified");
  draft.routes[0].branches.pop();
  assert.equal(evaluateFunnel(validateDefinition(draft), input({ event: { ...event, properties: { eligible: false } } })).to, "finished");
  assert.equal(evaluateFunnel(validateDefinition(draft), input({ event: { ...event, type: "unrelated" } })).outcome, "WAIT");
});

test("only the first trigger-eligible route runs even when it chooses WAIT", () => {
  const draft = definition({ field: { scope: "EVENT", key: "allowed" }, type: "boolean", op: "eq", value: true });
  draft.routes.push({ ...draft.routes[0], id: "later-route", branches: [{ id: "unconditional", to: "new" }] });
  const result = evaluateFunnel(validateDefinition(draft), input({ event: { ...event, properties: { allowed: false } } }));
  assert.equal(result.outcome, "WAIT");
  assert.equal(result.ruleId, "entry");
});

test("property changes must name the qualified changed field and cannot resurrect another event", () => {
  const field = { scope: "PROPERTY", sourceId: "crm", type: "custom.score", key: "score" } as const;
  const predicate: Condition = { field, type: "number", op: "gte", value: 10 };
  const draft = definition(predicate);
  const properties = { [fieldKey(field)]: { state: "VALUE", value: 20 } } as const;
  const scoreEvent = { ...event, sourceId: "crm", type: "custom.score", properties: { score: 20 } };
  assert.equal(evaluateFunnel(validateDefinition(draft), input({ properties, event: scoreEvent, changedFields: [fieldKey(field)] })).outcome, "WAIT");
  draft.routes[0].trigger = { kind: "PROPERTY_CHANGE", sourceId: "crm", type: "custom.score", key: "score" };
  const parsed = validateDefinition(draft);
  assert.equal(evaluateFunnel(parsed, input({ properties, event: scoreEvent })).outcome, "WAIT");
  assert.equal(evaluateFunnel(parsed, input({ properties, event: scoreEvent, changedFields: ["score"] })).outcome, "WAIT");
  assert.equal(evaluateFunnel(parsed, input({ properties, event: scoreEvent, changedFields: [fieldKey(field)] })).outcome, "MOVE");
});

test("goal milestones allow explicit refund edges while terminal stages and late unrelated causes stay put", () => {
  const draft = definition();
  draft.routes.push({ id: "refund", from: "qualified", trigger: { kind: "EVENT", sourceId: "shop", type: "refund.succeeded" }, branches: [{ id: "record-refund", to: "finished" }], fallback: { kind: "WAIT" } });
  const parsed = validateDefinition(draft);
  const oldCheckout = { ...event, sourceId: "shop", type: "checkout.observed", occurredAt: "2026-01-01T00:00:00Z" };
  assert.equal(evaluateFunnel(parsed, input({ currentStage: "qualified", event: oldCheckout })).outcome, "WAIT");
  const refund = { ...event, sourceId: "shop", type: "refund.succeeded" };
  assert.equal(evaluateFunnel(parsed, input({ currentStage: "qualified", event: refund })).to, "finished");
  assert.equal(evaluateFunnel(parsed, input({ currentStage: "finished", event: refund })).outcome, "WAIT");
});

test("validation permits empty/manual-only drafts and returns detached JSON definitions", () => {
  assert.deepEqual(validateDefinition({ schemaVersion: 1, stages: [], entryStages: [], routes: [] }), { schemaVersion: 1, stages: [], entryStages: [], routes: [] });
  const draft = definition(); draft.routes = [];
  assert.equal(validateDefinition(draft).stages[0].name, "A custom first stage");
  const parsed = validateDefinition(draft);
  draft.stages[0].name = "Edited draft";
  assert.equal(parsed.stages[0].name, "A custom first stage");
  assert.equal(evaluateFunnel(parsed, input()).outcome, "WAIT");
});

test("definition validation rejects broken references, duplicate identities, forbidden exits and every automatic cycle", () => {
  const edits: Array<(draft: FunnelDefinition) => void> = [
    draft => { draft.stages.push({ ...draft.stages[0] }); },
    draft => { draft.routes.push({ ...draft.routes[0] }); },
    draft => { draft.routes[0].branches.push({ ...draft.routes[0].branches[0] }); },
    draft => { draft.entryStages.push("missing"); },
    draft => { draft.routes[0].branches[0].to = "missing"; },
    draft => { draft.routes[0].branches[0].to = "qualified"; },
    draft => { draft.routes[0].from = "missing"; },
    draft => { draft.routes[0].from = "finished"; },
    draft => { draft.routes[0].from = "new"; },
    draft => { draft.routes[0].from = "new"; draft.routes[0].branches = []; draft.routes[0].fallback = { kind: "MOVE", to: "new" }; },
    draft => {
      draft.routes[0].from = "qualified";
      draft.routes.push({ ...draft.routes[0], id: "back", from: "new", branches: [{ id: "back-branch", to: "qualified" }] });
    },
  ];
  for (const edit of edits) {
    const draft = definition(); edit(draft);
    assert.throws(() => validateDefinition(draft), { code: "INVALID_FUNNEL_DEFINITION", status: 400 });
  }
});

test("invalid predicate types and executable representations are rejected without executing them", () => {
  const conditions = [
    { all: [] }, { any: [] }, { all: [], any: [] },
    { field: { scope: "EVENT", key: "value" }, type: "number", op: "eq", value: "2" },
    { field: { scope: "EVENT", key: "value" }, type: "string", op: "gt", value: "A" },
    { field: { scope: "EVENT", key: "value" }, type: "boolean", op: "in", value: [true, "false"] },
    { field: { scope: "EVENT", key: "value" }, type: "string", op: "in", value: [] },
    { field: { scope: "EVENT", key: "value" }, type: "decimal", op: "eq", value: "1e10" },
    { field: { scope: "EVENT", key: "value" }, type: "datetime", op: "eq", value: "2026-02-30T00:00:00Z" },
    { field: { scope: "EVENT", key: "value" }, type: "datetime", op: "eq", value: "2026-10-17" },
    { field: { scope: "EVENT", key: "value" }, type: "boolean", op: "isKnown", value: true },
    { field: { scope: "EVENT", key: "value" }, type: "string", op: "eval", value: "process.exit()" },
    { expression: "process.exit()" },
  ];
  for (const condition of conditions) assert.throws(() => validateDefinition(definition(condition as Condition)), { code: "INVALID_FUNNEL_DEFINITION" });
  let invoked = false;
  const accessor = Object.defineProperty({}, "schemaVersion", { enumerable: true, get() { invoked = true; return 1; } });
  assert.throws(() => validateDefinition(accessor), { code: "INVALID_FUNNEL_DEFINITION" });
  assert.throws(() => validateDefinition({ ...definition(), toJSON() { invoked = true; return definition(); } }), { code: "INVALID_FUNNEL_DEFINITION" });
  assert.equal(invoked, false);
});

test("condition depth, node count, definition size and graph cardinality are bounded", () => {
  const leaf: Condition = { field: { scope: "EVENT", key: "enabled" }, type: "boolean", op: "eq", value: true };
  let deep = leaf;
  for (let i = 0; i < 8; i++) deep = { all: [deep] };
  assert.throws(() => validateDefinition(definition(deep)), { code: "INVALID_FUNNEL_DEFINITION" });
  assert.throws(() => validateDefinition(definition({ all: Array.from({ length: 256 }, () => ({ ...leaf })) })), { code: "INVALID_FUNNEL_DEFINITION" });
  const tooManyStages = definition();
  tooManyStages.stages = Array.from({ length: 257 }, (_, index) => ({ id: `stage-${index}`, name: `Stage ${index}`, goal: false, terminal: "NONE" }));
  assert.throws(() => validateDefinition(tooManyStages), { code: "INVALID_FUNNEL_DEFINITION" });
  const tooManyRoutes = definition();
  tooManyRoutes.routes = Array.from({ length: 513 }, (_, index) => ({ ...tooManyRoutes.routes[0], id: `route-${index}` }));
  assert.throws(() => validateDefinition(tooManyRoutes), { code: "INVALID_FUNNEL_DEFINITION" });
  assert.throws(() => validateDefinition({ ...definition(), extra: "x".repeat(131_073) }), { code: "INVALID_FUNNEL_DEFINITION" });
});

test("evaluation is deterministic, traces are JSON and prototype keys do not become observations", () => {
  const draft = validateDefinition(definition({ field: { scope: "EVENT", key: "toString" }, type: "string", op: "isMissing" }));
  const one = evaluateFunnel(draft, input()), two = evaluateFunnel(draft, input());
  assert.equal(one.outcome, "MOVE");
  assert.deepEqual(one, two);
  assert.deepEqual(JSON.parse(JSON.stringify(one.trace)), one.trace);
  assert.throws(() => evaluateFunnel(draft, input({ event: { ...event, occurredAt: "yesterday" } })), { code: "INVALID_FUNNEL_EVALUATION" });
  assert.throws(() => evaluateFunnel(draft, input({ currentStage: "missing-stage" })), { code: "INVALID_FUNNEL_EVALUATION" });
});

test("consumed occurrences cannot match EVENT or its fallback but can supply a genuine property change", () => {
  const draft = definition();
  draft.routes[0].branches = [];
  draft.routes[0].fallback = { kind: "MOVE", to: "new" };
  draft.routes.push({ id: "property-update", from: null, trigger: { kind: "PROPERTY_CHANGE", sourceId: event.sourceId, type: event.type, key: "status" }, branches: [{ id: "changed", to: "new" }], fallback: { kind: "WAIT" } });
  const parsed = validateDefinition(draft);
  assert.equal(evaluateFunnel(parsed, input()).reason, "FALLBACK_MOVE");
  assert.equal(evaluateFunnel(parsed, input({ eventEligible: false })).outcome, "WAIT");
  const changed = evaluateFunnel(parsed, input({ eventEligible: false, changedFields: [fieldKey({ sourceId: event.sourceId, type: event.type, key: "status" })] }));
  assert.equal(changed.outcome, "MOVE");
  assert.equal(changed.ruleId, "property-update");
});
