"use client";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, applyNodeChanges, type Node, type NodeChange, type NodeProps, type ReactFlowInstance } from "@xyflow/react";
import type { FunnelDefinition } from "../../server/funnels/funnelDefinition";
import { connectionIssue, funnelEdges } from "./funnelGraph";
import type { UiSource } from "./funnelUi";

type StageNode = Node<{ name: string; order: number; entry: boolean; goal: boolean; terminal: string; events: string[]; campaigns: number; actions: number; sourceNames: string[] }, "stage">;
type EntryNode = Node<{ name: string }, "entry">;
type CanvasNode = StageNode | EntryNode;

const StageCard = memo(function StageCard({ data, selected, isConnectable }: NodeProps<StageNode>) {
  return <div className={`funnel-stage-card ${selected ? "is-selected" : ""} ${data.goal ? "is-goal" : ""}`}>
    <Handle type="target" position={Position.Top} isConnectable={isConnectable} aria-label={`Connect into ${data.name}`} />
    <div className="funnel-stage-card-top"><span className="funnel-stage-number">{String(data.order).padStart(2, "0")}</span><span className="funnel-stage-kind">{data.goal ? "Conversion goal" : data.entry ? "Entry stage" : "Journey stage"}</span>{data.terminal !== "NONE" && <span className="funnel-node-badge">{data.terminal === "SUCCESS" ? "Success exit" : "Exit"}</span>}</div>
    <strong className="funnel-stage-title">{data.name || "Unnamed stage"}</strong>
    <div className="funnel-stage-signal"><span className="funnel-signal-dot" aria-hidden="true" /><span>{data.events[0] ?? "Manual movement"}{data.events.length > 1 ? ` +${data.events.length - 1}` : ""}</span></div>
    {data.sourceNames.length > 0 && <p className="funnel-stage-source">{data.sourceNames.join(" · ")}</p>}
    <div className="funnel-stage-card-bottom"><span>{data.campaigns} campaign {data.campaigns === 1 ? "link" : "links"}</span><span className={data.actions ? "funnel-action-present" : ""}>{data.actions ? `${data.actions} optional ${data.actions === 1 ? "action" : "actions"}` : "Tracking only"}</span></div>
    <Handle type="source" position={Position.Bottom} isConnectable={isConnectable && data.terminal === "NONE"} aria-label={`Connect from ${data.name}`} />
  </div>;
});
const JourneyEntry = memo(function JourneyEntry({ isConnectable }: NodeProps<EntryNode>) {
  return <div className="funnel-entry-node"><span className="funnel-entry-symbol" aria-hidden="true">↳</span><div><strong>New journey</strong><span>Starts with qualifying evidence</span></div><Handle type="source" position={Position.Bottom} isConnectable={isConnectable} aria-label="Connect a journey entry" /></div>;
});
const nodeTypes = { stage: StageCard, entry: JourneyEntry };
function entryNode(definition: FunnelDefinition) { let id = "__launchpad_canvas_entry__"; while (definition.stages.some(stage => stage.id === id)) id += "_"; return id; }
function arrange(definition: FunnelDefinition, sources: UiSource[]): CanvasNode[] {
  const depth = new Map(definition.stages.map(stage => [stage.id, 1])), links = funnelEdges(definition);
  for (let pass = 0; pass < definition.stages.length; pass++) for (const edge of links)
    if (edge.from) depth.set(edge.to, Math.max(depth.get(edge.to) ?? 1, (depth.get(edge.from) ?? 1) + 1));
  const rowSizes = new Map<number, number>();
  for (const level of depth.values()) rowSizes.set(level, (rowSizes.get(level) ?? 0) + 1);
  const rows = new Map<number, number>();
  return [{ id: entryNode(definition), position: { x: 0, y: 0 }, data: { name: "New journey" }, type: "entry", deletable: false, width: 270, ariaLabel: "New journey, connect qualifying evidence to an entry stage" }, ...definition.stages.map((stage, index): StageNode => {
    const level = depth.get(stage.id) ?? 1, column = rows.get(level) ?? 0; rows.set(level, column + 1);
    const incoming = definition.routes.filter(route => route.branches.some(branch => branch.to === stage.id) || route.fallback.kind === "MOVE" && route.fallback.to === stage.id);
    return { id: stage.id, position: { x: (column - ((rowSizes.get(level) ?? 1) - 1) / 2) * 340, y: level * 270 - 90 }, type: "stage", deletable: false, width: 270,
      ariaLabel: `${stage.name || "Unnamed stage"}${stage.goal ? ", goal" : ""}. Select to edit stage settings.`,
      data: { name: stage.name, order: index + 1, goal: stage.goal, terminal: stage.terminal, entry: definition.entryStages.includes(stage.id),
        events: [...new Set(incoming.map(route => route.trigger.type))], sourceNames: [...new Set(incoming.map(route => sources.find(source => source.id === route.trigger.sourceId)?.name ?? "Unavailable source"))],
        campaigns: (definition.campaignLinks ?? []).filter(link => link.stageId === stage.id).length, actions: (definition.stageActions ?? []).filter(action => action.stageId === stage.id).length },
    };
  })];
}

export default function FunnelCanvas({ definition, sources, selectedStageId, onSelectStage, onConnect, disabled = false }: {
  definition: FunnelDefinition; sources: UiSource[]; selectedStageId: string | null; onSelectStage: (id: string) => void;
  onConnect: (from: string | null, to: string) => void; disabled?: boolean;
}) {
  const ENTRY = entryNode(definition);
  const [nodes, setNodes] = useState<CanvasNode[]>(() => arrange(definition, sources)), [flow, setFlow] = useState<ReactFlowInstance<CanvasNode> | null>(null);
  useEffect(() => {
    if (!flow) return;
    let frame = 0;
    const fitOnResize = () => {
      cancelAnimationFrame(frame);
      // Let React Flow finish measuring its new viewport before fitting nodes.
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => { void flow.fitView({ padding: .25, maxZoom: .95, duration: 0 }); }); });
    };
    window.addEventListener("resize", fitOnResize);
    return () => { window.removeEventListener("resize", fitOnResize); cancelAnimationFrame(frame); };
  }, [flow]);
  useEffect(() => { setNodes(old => arrange(definition, sources).map(node => {
    const previous = old.find(prior => prior.id === node.id);
    // Keep React Flow's measurements so selection and typing do not hide nodes
    // while their handles are measured again.
    return { ...previous, ...node, position: previous?.position ?? node.position, selected: node.id === selectedStageId };
  })); }, [definition, sources, selectedStageId]);
  const edges = useMemo(() => funnelEdges(definition).map(edge => ({ id: edge.id, source: edge.from ?? ENTRY, target: edge.to,
    label: edge.label, type: "smoothstep", deletable: false, markerEnd: { type: MarkerType.ArrowClosed, color: "oklch(var(--bc) / .45)" },
    style: { stroke: "oklch(var(--bc) / .4)", strokeWidth: 1.5 }, labelStyle: { fill: "oklch(var(--bc))", fontSize: 11 }, labelBgStyle: { fill: "oklch(var(--b1))" }, labelBgPadding: [8, 5] as [number, number], labelBgBorderRadius: 5 })), [definition, ENTRY]);
  const changes = useCallback((items: NodeChange<CanvasNode>[]) => {
    const selection = items.find(item => item.type === "select" && item.selected && item.id !== ENTRY);
    if (!disabled && selection?.type === "select" && selection.id !== selectedStageId) onSelectStage(selection.id);
    setNodes(old => applyNodeChanges(items.filter(item => item.type !== "remove"), old));
  }, [ENTRY, disabled, onSelectStage, selectedStageId]);
  return <section data-funnel-canvas aria-label="Funnel canvas" className="funnel-canvas-shell">
    <div className="funnel-canvas-toolbar"><div><strong>Journey canvas</strong><p>{definition.stages.length} stages <span aria-hidden="true">·</span> {definition.routes.length} event rules</p></div>
      <button className="btn btn-ghost min-h-11 normal-case" type="button" disabled={disabled} onClick={() => { const arranged = arrange(definition, sources); setNodes(old => old.map(node => ({ ...node, position: arranged.find(item => item.id === node.id)?.position ?? node.position }))); requestAnimationFrame(() => flow?.fitView({ padding: .25, duration: 0 })); }}>Arrange stages</button></div>
    <div className="funnel-canvas-viewport" data-testid="funnel-canvas"><ReactFlow<CanvasNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={changes} onInit={setFlow}
      onNodeClick={(_, node) => { if (!disabled && node.id !== ENTRY) onSelectStage(node.id); }}
      onConnect={connection => { if (!disabled && connection.source && connection.target) onConnect(connection.source === ENTRY ? null : connection.source, connection.target); }}
      isValidConnection={connection => Boolean(connection.source && connection.target && !connectionIssue(definition, connection.source === ENTRY ? null : connection.source, connection.target))}
      nodesConnectable={!disabled} nodesDraggable={!disabled} nodesFocusable={!disabled} elementsSelectable={!disabled} edgesFocusable={false} edgesReconnectable={false} deleteKeyCode={null}
      fitView fitViewOptions={{ padding: .25, maxZoom: .95 }} minZoom={.2} maxZoom={1.6} snapToGrid snapGrid={[20, 20]}
      ariaLabelConfig={{ "controls.zoomIn.ariaLabel": "Zoom in on funnel", "controls.zoomOut.ariaLabel": "Zoom out of funnel", "controls.fitView.ariaLabel": "Fit all funnel stages" }}>
      <Background gap={22} size={1} color="oklch(var(--bc) / .12)" /><Controls showInteractive={false} />
    </ReactFlow></div>
    <div className="funnel-canvas-caption">Select a stage to configure it. Connect the dots to add an event rule.<span>Layout is kept for this visit. Rules are saved with your draft.</span></div>
  </section>;
}
