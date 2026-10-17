import { validateCondition, validateDefinition, type Condition, type FunnelDefinition, type Scalar, type ValueType } from "../../server/funnels/funnelDefinition";

export type FunnelGraphEdge = { id: string; from: string | null; to: string; routeId: string; branchId?: string; kind: "BRANCH" | "FALLBACK"; label: string };
export function funnelEdges(definition: FunnelDefinition): FunnelGraphEdge[] {
  return definition.routes.flatMap((route, routeIndex) => [
    ...route.branches.map((branch, index): FunnelGraphEdge => ({ id: `route:${route.id}:branch:${branch.id}`, from: route.from, to: branch.to,
      routeId: route.id, branchId: branch.id, kind: "BRANCH", label: `Rule ${routeIndex + 1} · Branch ${index + 1}${branch.when ? "" : " · Always"}` })),
    ...(route.fallback.kind === "MOVE" ? [{ id: `route:${route.id}:fallback`, from: route.from, to: route.fallback.to, routeId: route.id,
      kind: "FALLBACK" as const, label: `Rule ${routeIndex + 1} · Otherwise` }] : []),
  ]);
}

export function connectionIssue(definition: FunnelDefinition, from: string | null, to: string): string | null {
  if (!definition.stages.some(stage => stage.id === to)) return "Choose a destination stage.";
  if (from === null) return definition.entryStages.includes(to) ? null : "Allow this stage as an entry before adding an entry rule.";
  const source = definition.stages.find(stage => stage.id === from);
  if (!source) return "Choose a starting stage.";
  if (source.terminal !== "NONE") return "An exit stage cannot have outgoing rules. Change its exit setting first.";
  if (from === to) return "A stage cannot automatically return to itself.";
  const edges = funnelEdges(definition), visited = new Set<string>();
  const pending = [to];
  while (pending.length) {
    const id = pending.pop()!;
    if (id === from) return "This connection would create an automatic cycle. Use an explicit new journey instead.";
    if (visited.has(id)) continue;
    visited.add(id); pending.push(...edges.filter(edge => edge.from === id).map(edge => edge.to));
  }
  return null;
}
export function connectStages(definition: FunnelDefinition, input: { id: string; from: string | null; to: string; sourceId: string; type: string }): FunnelDefinition {
  const issue = connectionIssue(definition, input.from, input.to);
  if (issue) throw new Error(issue);
  if (!input.sourceId.trim() || !input.type.trim()) throw new Error("Choose the source and event that authorize this connection.");
  return validateDefinition({ ...definition, routes: [...definition.routes, { id: input.id, from: input.from,
    trigger: { kind: "EVENT", sourceId: input.sourceId, type: input.type }, branches: [], fallback: { kind: "MOVE", to: input.to } }] });
}
export function addStage(definition: FunnelDefinition, stage: { id: string; name: string }, afterStageId?: string): FunnelDefinition {
  if (definition.stages.some(item => item.id === stage.id)) throw new Error("Stage IDs must be unique.");
  const stages = [...definition.stages], after = afterStageId ? stages.findIndex(item => item.id === afterStageId) : -1;
  stages.splice(after >= 0 ? after + 1 : stages.length, 0, { ...stage, goal: false, terminal: "NONE" });
  return validateDefinition({ ...definition, stages, entryStages: definition.stages.length ? definition.entryStages : [stage.id] });
}

/** Insert on one path only. The onward transition requires its own later event. */
export function insertStageOnEdge(definition: FunnelDefinition, input: {
  edgeId: string; stage: { id: string; name: string }; routeId: string; sourceId: string; type: string;
}): FunnelDefinition {
  const edge = funnelEdges(definition).find(item => item.id === input.edgeId);
  if (!edge) throw new Error("This connection no longer exists. Select it again.");
  let next = addStage(definition, input.stage, edge.from ?? undefined);
  if (edge.from === null) next = { ...next, entryStages: [...next.entryStages, input.stage.id] };
  next = { ...next, routes: next.routes.map(route => route.id !== edge.routeId ? route : {
    ...route,
    branches: route.branches.map(branch => branch.id === edge.branchId ? { ...branch, to: input.stage.id } : branch),
    fallback: edge.kind === "FALLBACK" ? { kind: "MOVE", to: input.stage.id } : route.fallback,
  }) };
  return connectStages(next, { id: input.routeId, from: input.stage.id, to: edge.to, sourceId: input.sourceId, type: input.type });
}

/** A fork joins the existing ordered rule, preserving its otherwise path. */
export function forkRoute(definition: FunnelDefinition, input: {
  routeId: string; branchId: string; to: string; when: Condition; beforeBranchId?: string;
}): FunnelDefinition {
  const route = definition.routes.find(item => item.id === input.routeId);
  if (!route) throw new Error("Choose an existing event rule to fork.");
  const issue = connectionIssue(definition, route.from, input.to);
  if (issue) throw new Error(issue);
  const when = validateCondition(input.when);
  const branches = [...route.branches];
  const at = input.beforeBranchId ? branches.findIndex(branch => branch.id === input.beforeBranchId) : branches.findIndex(branch => !branch.when);
  if (input.beforeBranchId && at < 0) throw new Error("This branch no longer exists. Select it again.");
  branches.splice(at < 0 ? branches.length : at, 0, { id: input.branchId, to: input.to, when });
  return validateDefinition({ ...definition, routes: definition.routes.map(item => item.id === route.id ? { ...route, branches } : item) });
}
export function removeStage(definition: FunnelDefinition, stageId: string): FunnelDefinition {
  return { ...definition, stages: definition.stages.filter(stage => stage.id !== stageId), entryStages: definition.entryStages.filter(id => id !== stageId),
    routes: definition.routes.filter(route => route.from !== stageId).map(route => ({ ...route,
      branches: route.branches.filter(branch => branch.to !== stageId),
      fallback: route.fallback.kind === "MOVE" && route.fallback.to === stageId ? { kind: "WAIT" as const } : route.fallback })),
    ...(definition.campaignLinks ? { campaignLinks: definition.campaignLinks.filter(link => link.stageId !== stageId) } : {}),
    ...(definition.stageActions ? { stageActions: definition.stageActions.filter(action => action.stageId !== stageId) } : {}),
  };
}
export function moveStage(definition: FunnelDefinition, stageId: string, direction: -1 | 1): FunnelDefinition {
  const index = definition.stages.findIndex(stage => stage.id === stageId), target = index + direction;
  if (index < 0 || target < 0 || target >= definition.stages.length) return definition;
  const stages = [...definition.stages]; [stages[index], stages[target]] = [stages[target], stages[index]];
  return { ...definition, stages };
}

/** No implicit numeric coercion: exact decimal/datetime strings stay strings. */
export function parseConditionScalar(raw: string, type: ValueType): { value: Scalar; error?: never } | { value?: never; error: string } {
  let value: Scalar = raw;
  if (type === "number") {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw) || !Number.isFinite(Number(raw))) return { error: "Enter a finite number." };
    value = Number(raw);
  } else if (type === "boolean") {
    if (raw !== "true" && raw !== "false") return { error: "Choose true or false." };
    value = raw === "true";
  }
  try { validateCondition({ field: { scope: "EVENT", key: "value" }, type, op: "eq", value }); return { value }; }
  catch { return { error: type === "decimal" ? "Use an exact decimal, such as 19.95, without an exponent." : type === "datetime" ?
    "Use an ISO timestamp with a timezone, such as 2026-10-19T10:00:00Z." : "Use text of at most 4,096 characters." }; }
}
export function conditionNodes(condition?: Condition): number {
  if (!condition) return 0;
  if ("all" in condition) return 1 + condition.all.reduce((sum, child) => sum + conditionNodes(child), 0);
  if ("any" in condition) return 1 + condition.any.reduce((sum, child) => sum + conditionNodes(child), 0);
  return 1;
}
