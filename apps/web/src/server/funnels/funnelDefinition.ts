import { fail } from "../security/errors";

export type Scalar = string | number | boolean | null;
export type JsonSerializable = Scalar | JsonSerializable[] | { [key: string]: JsonSerializable };
export type PropertyField = { scope: "PROPERTY"; sourceId: string; type: string; key: string };
export type FieldRef = { scope: "EVENT"; key: string } | PropertyField;
export type ValueType = "string" | "boolean" | "number" | "decimal" | "datetime";
export type Operator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "isKnown" | "isMissing" | "isNull";
export type Condition = { all: Condition[] } | { any: Condition[] } | {
  field: FieldRef; type: ValueType; op: Operator; value?: Scalar | Scalar[];
};
export type PropertyValue = { state: "VALUE"; value: Scalar } | { state: "UNKNOWN"; reason: "CONFLICT" | "UNAVAILABLE" };
export type PropertyValues = Record<string, PropertyValue>;
export type Trigger = { kind: "EVENT"; sourceId: string; type: string }
  | { kind: "PROPERTY_CHANGE"; sourceId: string; type: string; key: string };
export type FunnelStage = { id: string; name: string; goal: boolean; terminal: "NONE" | "SUCCESS" | "FAILURE" };
export type FunnelRoute = {
  id: string; from: string | null; trigger: Trigger;
  branches: { id: string; to: string; when?: Condition }[];
  fallback: { kind: "WAIT" } | { kind: "MOVE"; to: string };
};
export type FunnelCampaignLink = { id: string; stageId: string; campaignId: string; purpose: "ATTRIBUTION" };
export type FunnelStageAction = { id: string; stageId: string; campaignId: string } & (
  | { kind: "EMAIL_ENROLL"; revisionId: string; delaySeconds: number; expiresAfterDueSeconds: number; stopOnStageExit: boolean; stopOnGoal: boolean }
  | { kind: "EMAIL_STOP" });
export type FunnelDefinition = { schemaVersion: 1; stages: FunnelStage[]; entryStages: string[]; routes: FunnelRoute[];
  campaignLinks?: FunnelCampaignLink[]; stageActions?: FunnelStageAction[] };
export type EvaluationInput = {
  currentStage: string | null;
  event: { sourceId: string; type: string; properties: Record<string, Scalar>; occurredAt: string };
  properties: PropertyValues;
  changedFields: string[];
  /** False when this occurrence was consumed but its newer property observation is eligible. */
  eventEligible?: boolean;
};
export type EvaluationResult = {
  outcome: "MOVE" | "WAIT" | "UNKNOWN"; to?: string; ruleId?: string; reason: string; trace: JsonSerializable;
};
const utf8 = new TextEncoder();

/** A JSON tuple avoids collisions between arbitrary source, event-type and property keys. */
export function fieldKey(field: Pick<PropertyField, "sourceId" | "type" | "key">): string {
  return JSON.stringify([field.sourceId, field.type, field.key]);
}

function invalid(path: string, reason: string): never {
  return fail("INVALID_FUNNEL_DEFINITION", 400, `${path}: ${reason}`);
}
type Obj = Record<string, unknown>;
function object(value: unknown, path: string): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(path, "must be an object");
  return value as Obj;
}
function keys(value: Obj, allowed: string[], path: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid(path, "contains unsupported fields");
}
function text(value: unknown, path: string, max = 128): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) invalid(path, `must be nonempty text of at most ${max} characters`);
  return value;
}
function list(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid(path, `must be an array with at most ${max} items`);
  return value;
}
function unique(values: string[], path: string): void {
  if (new Set(values).size !== values.length) invalid(path, "contains duplicate IDs");
}
function jsonClone(value: unknown): unknown {
  let nodes = 0;
  const seen = new Set<object>();
  function copy(item: unknown, depth: number): JsonSerializable {
    if (++nodes > 20_000 || depth > 32) invalid("definition", "exceeds its structural limits");
    if (typeof item === "string" && utf8.encode(item).byteLength > 131_072) invalid("definition", "exceeds the 128 KiB size limit");
    if (item === null || typeof item === "boolean" || typeof item === "string") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (!item || typeof item !== "object" || seen.has(item)) invalid("definition", "must contain only finite, acyclic JSON data");
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) invalid("definition", "must contain plain JSON objects");
    seen.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Reflect.ownKeys(item).some(key => typeof key !== "string") || Object.values(descriptors).some(descriptor => descriptor.get || descriptor.set)) invalid("definition", "must not contain accessors or executable values");
    let result: JsonSerializable;
    if (Array.isArray(item)) {
      if (item.length > 20_000) invalid("definition", "exceeds its structural limits");
      result = Array.from({ length: item.length }, (_, index) => copy(descriptors[String(index)]?.value, depth + 1));
    } else {
      const record: Record<string, JsonSerializable> = Object.create(null);
      for (const [key, descriptor] of Object.entries(descriptors)) record[key] = copy(descriptor.value, depth + 1);
      result = record;
    }
    seen.delete(item);
    return result;
  }
  const copied = copy(value, 0);
  const raw = JSON.stringify(copied);
  if (utf8.encode(raw).byteLength > 131_072) invalid("definition", "exceeds the 128 KiB size limit");
  return JSON.parse(raw) as unknown;
}

const TYPES: ValueType[] = ["string", "boolean", "number", "decimal", "datetime"];
const OPERATORS: Operator[] = ["eq", "neq", "gt", "gte", "lt", "lte", "in", "isKnown", "isMissing", "isNull"];
const PRESENCE = new Set<Operator>(["isKnown", "isMissing", "isNull"]);
function decimal(value: unknown): { coefficient: bigint; scale: number } | undefined {
  if (typeof value !== "string" || value.length > 128 || !/^-?\d+(?:\.\d+)?$/.test(value)) return undefined;
  const [whole, fraction = ""] = value.split(".");
  return { coefficient: BigInt(whole + fraction), scale: fraction.length };
}
function instant(value: unknown): bigint | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) return undefined;
  const millis = Date.parse(`${value.slice(0, 19)}${match[8]}`);
  if (!Number.isFinite(millis)) return undefined;
  return BigInt(millis) * 1_000_000n + BigInt((match[7] ?? "").padEnd(9, "0"));
}
function correctType(value: unknown, type: ValueType): boolean {
  if (type === "string") return typeof value === "string" && value.length <= 4096;
  if (type === "boolean") return typeof value === "boolean";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "decimal") return decimal(value) !== undefined;
  return instant(value) !== undefined;
}
function parseCondition(value: unknown, path: string, depth: number, budget: { nodes: number }): Condition {
  if (depth > 8 || ++budget.nodes > 256) invalid(path, "conditions exceed depth 8 or the total 256-node limit");
  const condition = object(value, path);
  if (Object.hasOwn(condition, "all") || Object.hasOwn(condition, "any")) {
    const kind = Object.hasOwn(condition, "all") ? "all" : "any";
    keys(condition, [kind], path);
    const children = list(condition[kind], `${path}.${kind}`, 256);
    if (!children.length) invalid(path, "condition groups must not be empty");
    const parsed = children.map((child, index) => parseCondition(child, `${path}.${kind}[${index}]`, depth + 1, budget));
    return kind === "all" ? { all: parsed } : { any: parsed };
  }
  keys(condition, ["field", "type", "op", "value"], path);
  const field = object(condition.field, `${path}.field`);
  keys(field, field.scope === "PROPERTY" ? ["scope", "sourceId", "type", "key"] : ["scope", "key"], `${path}.field`);
  if (field.scope !== "EVENT" && field.scope !== "PROPERTY") invalid(`${path}.field.scope`, "must be EVENT or PROPERTY");
  const key = text(field.key, `${path}.field.key`);
  const parsedField: FieldRef = field.scope === "EVENT" ? { scope: "EVENT", key }
    : { scope: "PROPERTY", key, sourceId: text(field.sourceId, `${path}.field.sourceId`, 256), type: text(field.type, `${path}.field.type`) };
  if (!TYPES.includes(condition.type as ValueType)) invalid(`${path}.type`, "is unsupported");
  if (!OPERATORS.includes(condition.op as Operator)) invalid(`${path}.op`, "is unsupported");
  const type = condition.type as ValueType, op = condition.op as Operator;
  if (PRESENCE.has(op)) {
    if (Object.hasOwn(condition, "value")) invalid(`${path}.value`, "must be omitted for presence operators");
    return { field: parsedField, type, op };
  }
  if (["gt", "gte", "lt", "lte"].includes(op) && !["number", "decimal", "datetime"].includes(type)) invalid(path, "ordered comparisons require number, decimal or datetime values");
  if (op === "in") {
    const values = list(condition.value, `${path}.value`, 100);
    if (!values.length || values.some(value => !correctType(value, type))) invalid(`${path}.value`, "must be a nonempty list of values matching the declared type");
    return { field: parsedField, type, op, value: values as Scalar[] };
  }
  if (!correctType(condition.value, type)) invalid(`${path}.value`, "does not match the declared type");
  return { field: parsedField, type, op, value: condition.value as Scalar };
}

export function validateCondition(value: unknown): Condition {
  return parseCondition(jsonClone(value), "condition", 1, { nodes: 0 });
}

export function validateDefinition(value: unknown): FunnelDefinition {
  const body = object(jsonClone(value), "definition");
  keys(body, ["schemaVersion", "stages", "entryStages", "routes", "campaignLinks", "stageActions"], "definition");
  if (body.schemaVersion !== 1) invalid("schemaVersion", "must be 1");
  const stages = list(body.stages, "stages", 256).map((item, index): FunnelStage => {
    const path = `stages[${index}]`, stage = object(item, path);
    keys(stage, ["id", "name", "goal", "terminal"], path);
    if (typeof stage.goal !== "boolean") invalid(`${path}.goal`, "must be a boolean");
    if (stage.terminal !== "NONE" && stage.terminal !== "SUCCESS" && stage.terminal !== "FAILURE") invalid(`${path}.terminal`, "must be NONE, SUCCESS or FAILURE");
    return { id: text(stage.id, `${path}.id`), name: text(stage.name, `${path}.name`, 256), goal: stage.goal, terminal: stage.terminal };
  });
  unique(stages.map(stage => stage.id), "stages");
  const ids = new Set(stages.map(stage => stage.id));
  const entryStages = list(body.entryStages, "entryStages", 256).map((item, index) => text(item, `entryStages[${index}]`));
  unique(entryStages, "entryStages");
  if (entryStages.some(id => !ids.has(id))) invalid("entryStages", "references a missing stage");
  const conditionBudget = { nodes: 0 };
  const routes = list(body.routes, "routes", 512).map((item, index): FunnelRoute => {
    const path = `routes[${index}]`, route = object(item, path);
    keys(route, ["id", "from", "trigger", "branches", "fallback"], path);
    const from = route.from === null ? null : text(route.from, `${path}.from`);
    if (from !== null && !ids.has(from)) invalid(`${path}.from`, "references a missing stage");
    if (stages.some(stage => stage.id === from && stage.terminal !== "NONE")) invalid(path, "terminal stages cannot have outgoing routes");
    const trigger = object(route.trigger, `${path}.trigger`);
    keys(trigger, trigger.kind === "PROPERTY_CHANGE" ? ["kind", "sourceId", "type", "key"] : ["kind", "sourceId", "type"], `${path}.trigger`);
    if (trigger.kind !== "EVENT" && trigger.kind !== "PROPERTY_CHANGE") invalid(`${path}.trigger.kind`, "must be EVENT or PROPERTY_CHANGE");
    const triggerBase = { sourceId: text(trigger.sourceId, `${path}.trigger.sourceId`, 256), type: text(trigger.type, `${path}.trigger.type`) };
    const parsedTrigger: Trigger = trigger.kind === "EVENT" ? { kind: "EVENT", ...triggerBase }
      : { kind: "PROPERTY_CHANGE", ...triggerBase, key: text(trigger.key, `${path}.trigger.key`) };
    function target(value: unknown, at: string): string {
      const id = text(value, at);
      if (!ids.has(id)) invalid(at, "references a missing stage");
      if (from === null && !entryStages.includes(id)) invalid(at, "entry routes must target an allowed entry stage");
      return id;
    }
    const branches = list(route.branches, `${path}.branches`, 256).map((item, branchIndex) => {
      const at = `${path}.branches[${branchIndex}]`, branch = object(item, at);
      keys(branch, ["id", "to", "when"], at);
      const when = branch.when === undefined ? undefined : parseCondition(branch.when, `${at}.when`, 1, conditionBudget);
      return { id: text(branch.id, `${at}.id`), to: target(branch.to, `${at}.to`), ...(when ? { when } : {}) };
    });
    unique(branches.map(branch => branch.id), `${path}.branches`);
    const fallback = object(route.fallback, `${path}.fallback`);
    keys(fallback, fallback.kind === "MOVE" ? ["kind", "to"] : ["kind"], `${path}.fallback`);
    if (fallback.kind !== "WAIT" && fallback.kind !== "MOVE") invalid(`${path}.fallback.kind`, "must be WAIT or MOVE");
    return { id: text(route.id, `${path}.id`), from, trigger: parsedTrigger, branches,
      fallback: fallback.kind === "WAIT" ? { kind: "WAIT" } : { kind: "MOVE", to: target(fallback.to, `${path}.fallback.to`) } };
  });
  unique(routes.map(route => route.id), "routes");
  const adjacency = new Map(stages.map(stage => [stage.id, new Set<string>()]));
  for (const route of routes) if (route.from !== null) {
    for (const branch of route.branches) adjacency.get(route.from)!.add(branch.to);
    if (route.fallback.kind === "MOVE") adjacency.get(route.from)!.add(route.fallback.to);
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) invalid("routes", "automatic cycles, including self-transitions, are unsupported");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of adjacency.get(id)!) visit(next);
    visiting.delete(id); visited.add(id);
  }
  for (const stage of stages) visit(stage.id);
  const campaignLinks = body.campaignLinks === undefined ? undefined : list(body.campaignLinks, "campaignLinks", 512).map((item, index): FunnelCampaignLink => {
    const path = `campaignLinks[${index}]`, link = object(item, path);
    keys(link, ["id", "stageId", "campaignId", "purpose"], path);
    if (link.purpose !== "ATTRIBUTION") invalid(`${path}.purpose`, "campaign associations support attribution; actions require separate enablement");
    const stageId = text(link.stageId, `${path}.stageId`);
    if (!ids.has(stageId)) invalid(`${path}.stageId`, "references a missing stage");
    return { id: text(link.id, `${path}.id`), stageId, campaignId: text(link.campaignId, `${path}.campaignId`), purpose: "ATTRIBUTION" };
  });
  if (campaignLinks) unique(campaignLinks.map(link => link.id), "campaignLinks");
  const stageActions = body.stageActions === undefined ? undefined : list(body.stageActions, "stageActions", 512).map((item, index): FunnelStageAction => {
    const path = `stageActions[${index}]`, action = object(item, path);
    if (action.kind !== "EMAIL_ENROLL" && action.kind !== "EMAIL_STOP") invalid(`${path}.kind`, "choose an implemented email enrolment or stop action");
    keys(action, action.kind === "EMAIL_STOP" ? ["id", "stageId", "kind", "campaignId"] :
      ["id", "stageId", "kind", "campaignId", "revisionId", "delaySeconds", "expiresAfterDueSeconds", "stopOnStageExit", "stopOnGoal"], path);
    const base = { id: text(action.id, `${path}.id`), stageId: text(action.stageId, `${path}.stageId`), campaignId: text(action.campaignId, `${path}.campaignId`) };
    if (!ids.has(base.stageId)) invalid(`${path}.stageId`, "references a missing stage");
    if (action.kind === "EMAIL_STOP") return { ...base, kind: "EMAIL_STOP" };
    const seconds = (value: unknown, name: string, fallback: number, min: number) => {
      const result = value ?? fallback;
      if (!Number.isSafeInteger(result) || Number(result) < min || Number(result) > 31_536_000) invalid(`${path}.${name}`, `must be an integer from ${min} to 31536000`);
      return Number(result);
    };
    for (const key of ["stopOnStageExit", "stopOnGoal"]) if (action[key] !== undefined && typeof action[key] !== "boolean") invalid(`${path}.${key}`, "must be a boolean");
    return { ...base, kind: "EMAIL_ENROLL", revisionId: text(action.revisionId, `${path}.revisionId`),
      delaySeconds: seconds(action.delaySeconds, "delaySeconds", 0, 0), expiresAfterDueSeconds: seconds(action.expiresAfterDueSeconds, "expiresAfterDueSeconds", 604_800, 1),
      stopOnStageExit: action.stopOnStageExit === undefined ? true : action.stopOnStageExit as boolean,
      stopOnGoal: action.stopOnGoal === undefined ? true : action.stopOnGoal as boolean };
  });
  if (stageActions) {
    unique(stageActions.map(action => action.id), "stageActions");
    unique(stageActions.map(action => JSON.stringify([action.stageId, action.campaignId])), "stageActions campaign per stage");
  }
  // Preserve absent fields so existing published definition digests remain stable.
  return { schemaVersion: 1, stages, entryStages, routes, ...(campaignLinks === undefined ? {} : { campaignLinks }),
    ...(stageActions === undefined ? {} : { stageActions }) };
}

type Truth = "TRUE" | "FALSE" | "UNKNOWN";
type ConditionResult = { truth: Truth; trace: JsonSerializable };
type Resolved = { state: "MISSING" } | { state: "UNKNOWN"; reason: string } | { state: "VALUE"; value: Scalar };
function resolve(field: FieldRef, input: EvaluationInput): Resolved {
  if (field.scope === "EVENT") return Object.hasOwn(input.event.properties, field.key)
    ? { state: "VALUE", value: input.event.properties[field.key] } : { state: "MISSING" };
  const key = fieldKey(field);
  return Object.hasOwn(input.properties, key) ? input.properties[key] : { state: "MISSING" };
}
function compare(left: Scalar, right: Scalar, type: ValueType): number {
  if (type === "decimal") {
    const a = decimal(left)!, b = decimal(right)!;
    const scale = Math.max(a.scale, b.scale);
    const x = a.coefficient * 10n ** BigInt(scale - a.scale), y = b.coefficient * 10n ** BigInt(scale - b.scale);
    return x === y ? 0 : x < y ? -1 : 1;
  }
  if (type === "datetime") {
    const a = instant(left)!, b = instant(right)!;
    return a === b ? 0 : a < b ? -1 : 1;
  }
  if (left === right) return 0;
  return (left as number) < (right as number) ? -1 : 1;
}
export function evaluateCondition(condition: Condition, input: EvaluationInput): ConditionResult {
  if ("all" in condition || "any" in condition) {
    const kind = "all" in condition ? "all" : "any";
    const children = ("all" in condition ? condition.all : condition.any).map(child => evaluateCondition(child, input));
    const truth: Truth = kind === "all"
      ? children.some(child => child.truth === "FALSE") ? "FALSE" : children.every(child => child.truth === "TRUE") ? "TRUE" : "UNKNOWN"
      : children.some(child => child.truth === "TRUE") ? "TRUE" : children.every(child => child.truth === "FALSE") ? "FALSE" : "UNKNOWN";
    return { truth, trace: { kind, truth, children: children.map(child => child.trace) } };
  }
  const resolved = resolve(condition.field, input);
  let truth: Truth, reason: string;
  if (resolved.state === "UNKNOWN") { truth = "UNKNOWN"; reason = resolved.reason; }
  else if (condition.op === "isMissing") { truth = resolved.state === "MISSING" ? "TRUE" : "FALSE"; reason = "PRESENCE_CHECK"; }
  else if (condition.op === "isKnown") { truth = resolved.state === "VALUE" && resolved.value !== null ? "TRUE" : "FALSE"; reason = "PRESENCE_CHECK"; }
  else if (resolved.state === "MISSING") { truth = "UNKNOWN"; reason = "MISSING"; }
  else if (condition.op === "isNull") { truth = resolved.value === null ? "TRUE" : "FALSE"; reason = "PRESENCE_CHECK"; }
  else if (resolved.value === null) { truth = "UNKNOWN"; reason = "NULL"; }
  else if (!correctType(resolved.value, condition.type)) { truth = "UNKNOWN"; reason = "TYPE_MISMATCH"; }
  else {
    let matches: boolean;
    if (condition.op === "in") matches = (condition.value as Scalar[]).some(value => compare(resolved.value, value, condition.type) === 0);
    else {
      const comparison = compare(resolved.value, condition.value as Scalar, condition.type);
      matches = condition.op === "eq" ? comparison === 0 : condition.op === "neq" ? comparison !== 0
        : condition.op === "gt" ? comparison > 0 : condition.op === "gte" ? comparison >= 0 : condition.op === "lt" ? comparison < 0 : comparison <= 0;
    }
    truth = matches ? "TRUE" : "FALSE"; reason = "COMPARED";
  }
  return { truth, trace: { kind: "predicate", field: { ...condition.field }, type: condition.type, op: condition.op,
    expected: condition.value ?? null, state: resolved.state, actual: resolved.state === "VALUE" ? resolved.value : null, truth, reason } };
}

/** Publication, source freshness, ownership and duplicate-cause admission are service concerns. */
export function evaluateFunnel(definition: FunnelDefinition, input: EvaluationInput): EvaluationResult {
  if (instant(input.event.occurredAt) === undefined) fail("INVALID_FUNNEL_EVALUATION", 400, "The event occurrence timestamp is invalid.");
  if (input.currentStage !== null && !definition.stages.some(stage => stage.id === input.currentStage)) fail("INVALID_FUNNEL_EVALUATION", 400, "The current stage is absent from this definition.");
  const route = definition.routes.find(route => route.from === input.currentStage
    && route.trigger.sourceId === input.event.sourceId && route.trigger.type === input.event.type
    && (route.trigger.kind === "EVENT" ? input.eventEligible !== false : input.changedFields.includes(fieldKey(route.trigger))));
  if (!route) return { outcome: "WAIT", reason: "NO_ELIGIBLE_ROUTE", trace: { currentStage: input.currentStage, routeId: null } };
  const branches: JsonSerializable[] = [];
  for (const branch of route.branches) {
    const result = branch.when ? evaluateCondition(branch.when, input) : { truth: "TRUE" as const, trace: { kind: "unconditional", truth: "TRUE" } };
    branches.push({ branchId: branch.id, result: result.trace });
    const trace = { routeId: route.id, selectedBranchId: result.truth === "TRUE" ? branch.id : null, branches };
    if (result.truth === "UNKNOWN") return { outcome: "UNKNOWN", ruleId: route.id, reason: "UNKNOWN_CONDITION", trace };
    if (result.truth === "TRUE") return { outcome: "MOVE", to: branch.to, ruleId: route.id, reason: "MATCHED_BRANCH", trace };
  }
  return route.fallback.kind === "MOVE"
    ? { outcome: "MOVE", to: route.fallback.to, ruleId: route.id, reason: "FALLBACK_MOVE", trace: { routeId: route.id, selectedBranchId: null, branches } }
    : { outcome: "WAIT", ruleId: route.id, reason: "FALLBACK_WAIT", trace: { routeId: route.id, selectedBranchId: null, branches } };
}
