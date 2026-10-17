"use client";
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Background, BaseEdge, ConnectionLineType, Controls, EdgeLabelRenderer, Handle, Position, ReactFlow, applyNodeChanges, getSmoothStepPath,
  type Edge, type EdgeProps, type Node, type NodeChange, type NodeProps, type ReactFlowInstance } from "@xyflow/react";
import type { Condition, FunnelDefinition } from "../../server/funnels/funnelDefinition";
import type { CanvasConnectionRequest } from "./CanvasConnectionDialog";
import { connectionIssue, funnelEdges } from "./funnelGraph";
import type { UiSource } from "./funnelUi";

type StageNode = Node<{ name: string; order: number; entry: boolean; goal: boolean; terminal: string; events: string[]; campaigns: number; actions: number; sourceNames: string[]; hasNext: boolean; conditional: boolean }, "stage">;
type EntryNode = Node<{ name: string; hasNext: boolean }, "entry">;
type CanvasNode = StageNode | EntryNode;
type JourneyEdge = Edge<{ title: string; detail: string; from: string | null; branched: boolean; disabled: boolean; onAdd: (request: CanvasConnectionRequest) => void }, "journey">;
const Actions = createContext<{ disabled: boolean; onAdd: (request: CanvasConnectionRequest) => void; onEdit: (id: string) => void }>({ disabled: true, onAdd: () => {}, onEdit: () => {} });
function Plus() { return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>; }
function AddTail({ from, name }: { from: string | null; name: string }) {
  const actions = useContext(Actions);
  return <div className="funnel-add-tail nodrag nopan"><span aria-hidden="true" /><button type="button" className="funnel-add-button" disabled={actions.disabled}
    onClick={event => { event.stopPropagation(); actions.onAdd({ from }); }} aria-label={from === null ? "Add from new journey" : `Add after ${name}`} title="Add the next step"><Plus /></button></div>;
}
function StageSymbol({ exit = false }: { exit?: boolean }) {
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">{exit ? <path d="M6 21V4m0 1c4-4 8 4 12 0v8c-4 4-8-4-12 0" /> : <><path d="M12 7v5M5 16v-4h14v4" /><rect x="9" y="2" width="6" height="5" rx="1" /><rect x="2" y="16" width="6" height="5" rx="1" /><rect x="16" y="16" width="6" height="5" rx="1" /></>}</svg>;
}
const StageCard = memo(function StageCard({ id, data, selected, isConnectable }: NodeProps<StageNode>) {
  const actions = useContext(Actions);
  const edit = (event: React.MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); event.currentTarget.focus({ preventScroll: true }); actions.onEdit(id); };
  if (data.terminal !== "NONE") return <div className={`funnel-exit-card ${data.terminal === "SUCCESS" ? "is-success" : "is-failure"} ${selected ? "is-selected" : ""}`} data-exit-stage={data.terminal}>
    <Handle type="target" position={Position.Top} isConnectable={isConnectable} aria-label={`Connect into ${data.name}`} />
    <span className="funnel-exit-symbol"><StageSymbol exit /></span><div><span className="funnel-exit-kind">{data.terminal === "SUCCESS" ? "Goal exit" : "Exit"}</span>
      <button type="button" className="nodrag nopan" disabled={actions.disabled} onClick={edit} aria-label={`Edit ${data.name}`}>{data.name || "Unnamed exit"}</button></div>
  </div>;
  return <div className="funnel-stage-node"><div className={`funnel-stage-card ${selected ? "is-selected" : ""} ${data.goal ? "is-goal" : ""}`}>
    <Handle type="target" position={Position.Top} isConnectable={isConnectable} aria-label={`Connect into ${data.name}`} />
    <div className="funnel-stage-card-top"><StageSymbol /><span className="funnel-stage-kind">{data.conditional ? "Conditional stage" : data.goal ? "Goal stage" : data.entry ? "Entry stage" : "Journey stage"}</span></div>
    <strong className="funnel-stage-title">{data.name || "Unnamed stage"}</strong>
    <div className="funnel-stage-signal"><span className="funnel-signal-dot" aria-hidden="true" /><span>{data.events[0] ?? "Manual movement"}{data.events.length > 1 ? ` +${data.events.length - 1}` : ""}</span></div>
    <div className="funnel-stage-summary">{data.campaigns ? `${data.campaigns} campaign links` : "No campaign linked"} · {data.actions ? `${data.actions} actions` : "Tracking only"}</div>
    <div className="funnel-stage-card-bottom nodrag nopan"><button type="button" disabled={actions.disabled} onClick={edit} aria-label={`Edit ${data.name}`}>Edit stage</button></div>
    <Handle type="source" position={Position.Bottom} isConnectable={isConnectable} aria-label={`Connect from ${data.name}`} />
  </div>{!data.hasNext && <AddTail from={id} name={data.name} />}</div>;
});
const JourneyEntry = memo(function JourneyEntry({ data, isConnectable }: NodeProps<EntryNode>) {
  return <div className="funnel-stage-node"><div className="funnel-entry-node"><div><strong>New journey</strong><span>Starts with qualifying evidence</span></div>
    <Handle type="source" position={Position.Bottom} isConnectable={isConnectable} aria-label="Connect a journey entry" /></div>
    {!data.hasNext && <AddTail from={null} name="New journey" />}</div>;
});
function conditionLabel(condition: Condition): string {
  if ("all" in condition) return `All ${condition.all.length} conditions match`;
  if ("any" in condition) return `Any of ${condition.any.length} conditions match`;
  const comparison = { eq: "=", neq: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤", in: "is one of", isKnown: "is known", isMissing: "is missing", isNull: "is null" }[condition.op];
  return `${condition.field.key} ${comparison}${condition.value === undefined ? "" : ` ${Array.isArray(condition.value) ? condition.value.join(", ") : String(condition.value)}`}`;
}
const PathConnector = memo(function PathConnector(props: EdgeProps<JourneyEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({ ...props, borderRadius: 3 });
  const data = props.data;
  // Place the control on its own branch, below the split. When a user drags a
  // destination above/beside its source, use the routed path's actual midpoint.
  const descending = props.targetY - props.sourceY > 80;
  const plusX = descending ? props.targetX : labelX;
  const plusY = descending ? props.sourceX === props.targetX && !data?.branched ? (props.sourceY + props.targetY) / 2 : (props.sourceY + props.targetY * 3) / 4 : labelY;
  return <><BaseEdge id={props.id} path={path} style={{ stroke: "var(--funnel-connector)", strokeWidth: 2 }} />
    {data && <EdgeLabelRenderer><div className="funnel-path-control nodrag nopan" data-edge-id={props.id} style={{ transform: `translate(-50%, -50%) translate(${plusX}px,${plusY}px)` }}>
      <button type="button" className="funnel-add-button" disabled={data.disabled} title={data.detail} aria-label={`Add on ${data.detail}`} onClick={() => data.onAdd({ from: data.from, edgeId: props.id })}><Plus /></button>
      <span className="funnel-path-label" title={data.detail}>{data.title}</span>
    </div></EdgeLabelRenderer>}
  </>;
});
const nodeTypes = { stage: StageCard, entry: JourneyEntry }, edgeTypes = { journey: PathConnector };
function entryNode(definition: FunnelDefinition) { let id = "__launchpad_canvas_entry__"; while (definition.stages.some(stage => stage.id === id)) id += "_"; return id; }
function arrange(definition: FunnelDefinition, sources: UiSource[]): CanvasNode[] {
  const depth = new Map(definition.stages.map(stage => [stage.id, 1])), links = funnelEdges(definition);
  for (let pass = 0; pass < definition.stages.length; pass++) for (const edge of links)
    if (edge.from) depth.set(edge.to, Math.max(depth.get(edge.to) ?? 1, (depth.get(edge.from) ?? 1) + 1));
  const rowSizes = new Map<number, number>();
  for (const level of depth.values()) rowSizes.set(level, (rowSizes.get(level) ?? 0) + 1);
  const rows = new Map<number, number>();
  return [{ id: entryNode(definition), position: { x: 0, y: 0 }, data: { name: "New journey", hasNext: links.some(edge => edge.from === null) }, type: "entry", deletable: false, width: 270, ariaLabel: "New journey, connect qualifying evidence to an entry stage" }, ...definition.stages.map((stage, index): StageNode => {
    const level = depth.get(stage.id) ?? 1, column = rows.get(level) ?? 0; rows.set(level, column + 1);
    const incoming = definition.routes.filter(route => route.branches.some(branch => branch.to === stage.id) || route.fallback.kind === "MOVE" && route.fallback.to === stage.id);
    return { id: stage.id, position: { x: (column - ((rowSizes.get(level) ?? 1) - 1) / 2) * 380, y: level * 350 - 150 }, type: "stage", deletable: false, width: 270,
      ariaLabel: `${stage.name || "Unnamed stage"}${stage.goal ? ", goal" : ""}. Use Edit stage to open settings.`,
      data: { name: stage.name, order: index + 1, hasNext: links.some(edge => edge.from === stage.id), conditional: incoming.some(route => route.branches.some(branch => branch.to === stage.id && branch.when)), goal: stage.goal, terminal: stage.terminal, entry: definition.entryStages.includes(stage.id),
        events: [...new Set(incoming.map(route => route.trigger.type))], sourceNames: [...new Set(incoming.map(route => sources.find(source => source.id === route.trigger.sourceId)?.name ?? "Unavailable source"))],
        campaigns: (definition.campaignLinks ?? []).filter(link => link.stageId === stage.id).length, actions: (definition.stageActions ?? []).filter(action => action.stageId === stage.id).length },
    };
  })];
}

export default function FunnelCanvas({ definition, sources, selectedStageId, onSelectStage, onEditStage, onConnect, onAdd, disabled = false, settingsOpen }: {
  definition: FunnelDefinition; sources: UiSource[]; selectedStageId: string | null; onSelectStage: (id: string) => void; onEditStage: (id: string) => void;
  onConnect: (from: string | null, to: string) => void; onAdd: (request: CanvasConnectionRequest) => void; disabled?: boolean; settingsOpen: boolean;
}) {
  const ENTRY = entryNode(definition);
  const [nodes, setNodes] = useState<CanvasNode[]>(() => arrange(definition, sources)), [flow, setFlow] = useState<ReactFlowInstance<CanvasNode, JourneyEdge> | null>(null);
  const topology = JSON.stringify([definition.stages.map(stage => [stage.id, stage.terminal]), funnelEdges(definition).map(edge => [edge.id, edge.from, edge.to])]), previousTopology = useRef(topology);
  const fit = useCallback(() => { requestAnimationFrame(() => requestAnimationFrame(() => { void flow?.fitView({ padding: .18, maxZoom: 1, duration: 0 }); })); }, [flow]);
  useEffect(() => {
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [fit]);
  useEffect(() => { fit(); }, [settingsOpen, fit]);
  useEffect(() => {
    const changed = previousTopology.current !== topology; previousTopology.current = topology;
    setNodes(old => arrange(definition, sources).map(node => {
      const previous = old.find(prior => prior.id === node.id);
      return { ...previous, ...node, position: changed ? node.position : previous?.position ?? node.position, selected: node.id === selectedStageId };
    }));
    if (changed) fit();
  }, [definition, sources, selectedStageId, topology, fit]);
  const edges = useMemo<JourneyEdge[]>(() => funnelEdges(definition).map(edge => {
    const route = definition.routes.find(item => item.id === edge.routeId)!;
    const from = definition.stages.find(stage => stage.id === edge.from)?.name ?? "New journey", to = definition.stages.find(stage => stage.id === edge.to)?.name ?? "stage";
    const branch = route.branches.find(item => item.id === edge.branchId);
    const title = edge.kind === "FALLBACK" ? route.branches.length ? "Otherwise" : route.trigger.type : branch?.when ? conditionLabel(branch.when) : "Always";
    return { id: edge.id, source: edge.from ?? ENTRY, target: edge.to, type: "journey", deletable: false,
      data: { title, detail: `${from} to ${to} · ${edge.label}`, from: edge.from, branched: funnelEdges(definition).filter(item => item.from === edge.from).length > 1, disabled, onAdd } };
  }), [definition, ENTRY, disabled, onAdd]);
  const changes = useCallback((items: NodeChange<CanvasNode>[]) => {
    const selection = items.find(item => item.type === "select" && item.selected && item.id !== ENTRY);
    if (!disabled && selection?.type === "select" && selection.id !== selectedStageId) onSelectStage(selection.id);
    setNodes(old => applyNodeChanges(items.filter(item => item.type !== "remove"), old));
  }, [ENTRY, disabled, onSelectStage, selectedStageId]);
  return <section data-funnel-canvas aria-label="Funnel canvas" className="funnel-canvas-shell">
    <div className="funnel-canvas-toolbar"><div><strong>Journey canvas</strong><p>One + on each path. Choose what happens next.</p></div><div className="flex flex-wrap gap-1">
      <button className="btn btn-ghost min-h-11 normal-case" type="button" disabled={disabled} onClick={() => { const arranged = arrange(definition, sources); setNodes(old => old.map(node => ({ ...node, position: arranged.find(item => item.id === node.id)?.position ?? node.position }))); fit(); }}>Arrange stages</button>
</div></div>
    <div className="funnel-canvas-viewport" data-testid="funnel-canvas"><Actions.Provider value={{ disabled, onAdd, onEdit: onEditStage }}><ReactFlow<CanvasNode, JourneyEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={changes} onInit={setFlow}
      onNodeClick={(event, node) => { if (!disabled && node.id !== ENTRY && !(event.target as Element).closest("button, .react-flow__handle")) onSelectStage(node.id); }}
      onConnect={connection => { if (!disabled && connection.source && connection.target) onConnect(connection.source === ENTRY ? null : connection.source, connection.target); }}
      isValidConnection={connection => Boolean(connection.source && connection.target && !connectionIssue(definition, connection.source === ENTRY ? null : connection.source, connection.target))}
      nodesConnectable={!disabled} nodesDraggable={!disabled} nodesFocusable={!disabled} elementsSelectable={!disabled} edgesFocusable={false} edgesReconnectable={false} deleteKeyCode={null}
      connectionLineType={ConnectionLineType.SmoothStep} connectionLineStyle={{ stroke: "var(--funnel-connector)", strokeWidth: 2 }} proOptions={{ hideAttribution: true }}
      fitView fitViewOptions={{ padding: .18, maxZoom: 1 }} minZoom={.15} maxZoom={1.6} snapToGrid snapGrid={[20, 20]}
      ariaLabelConfig={{ "controls.zoomIn.ariaLabel": "Zoom in on funnel", "controls.zoomOut.ariaLabel": "Zoom out of funnel", "controls.fitView.ariaLabel": "Fit all funnel stages" }}>
      <Background gap={22} size={1} color="oklch(var(--bc) / .18)" /><Controls showInteractive={false} />
    </ReactFlow></Actions.Provider></div>
    <div className="funnel-canvas-caption">Add with + or draw between the green connection points. Select Edit stage for details.<span>Connections follow saved event rules. Dragging only changes this visit’s layout.</span></div>
  </section>;
}
