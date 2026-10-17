"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Background, Controls, ReactFlow, applyNodeChanges, type Node, type NodeChange, type ReactFlowInstance } from "@xyflow/react";
import type { FunnelDefinition } from "../../server/funnels/funnelDefinition";
import { connectionIssue, funnelEdges } from "./funnelGraph";
import { buttonClass } from "./funnelUi";

function entryNode(definition: FunnelDefinition) { let id = "__launchpad_canvas_entry__"; while (definition.stages.some(stage => stage.id === id)) id += "_"; return id; }
function arrange(definition: FunnelDefinition): Node[] {
  const ENTRY = entryNode(definition);
  const depth = new Map(definition.stages.map(stage => [stage.id, 1]));
  const links = funnelEdges(definition);
  for (let pass = 0; pass < definition.stages.length; pass++) for (const edge of links)
    if (edge.from) depth.set(edge.to, Math.max(depth.get(edge.to) ?? 1, (depth.get(edge.from) ?? 1) + 1));
  const rows = new Map<number, number>();
  return [{ id: ENTRY, position: { x: 0, y: 80 }, data: { label: "New journey" }, type: "input", deletable: false }, ...definition.stages.map(stage => {
    const column = depth.get(stage.id) ?? 1, row = rows.get(column) ?? 0; rows.set(column, row + 1);
    return { id: stage.id, position: { x: column * 300, y: row * 150 + 80 }, data: { label: stage.name }, deletable: false };
  })];
}
export default function FunnelCanvas({ definition, selectedStageId, onSelectStage, onConnect, disabled = false }: {
  definition: FunnelDefinition; selectedStageId: string | null; onSelectStage: (id: string) => void;
  onConnect: (from: string | null, to: string) => void; disabled?: boolean;
}) {
  const ENTRY = entryNode(definition);
  const [nodes, setNodes] = useState<Node[]>(() => arrange(definition)), [flow, setFlow] = useState<ReactFlowInstance | null>(null);
  useEffect(() => { setNodes(old => arrange(definition).map(node => ({ ...old.find(prior => prior.id === node.id), ...node,
    position: old.find(prior => prior.id === node.id)?.position ?? node.position,
    selected: node.id === selectedStageId,
    data: { label: node.id === ENTRY ? "New journey" : (() => { const stage = definition.stages.find(s => s.id === node.id)!;
      return <div className="space-y-1 break-words"><strong>{stage.name}</strong><p className="text-xs">{[stage.goal && "Goal", stage.terminal !== "NONE" && stage.terminal, definition.entryStages.includes(stage.id) && "Entry"].filter(Boolean).join(" · ") || "Stage"}</p>
        <p className="text-xs">{(definition.campaignLinks ?? []).filter(link => link.stageId === stage.id).length} campaign links · {(definition.stageActions ?? []).filter(action => action.stageId === stage.id).length} optional actions</p></div>; })() },
    style: { width: 230, background: "oklch(var(--b1))", color: "oklch(var(--bc))", borderColor: node.id === selectedStageId ? "oklch(var(--p))" : "oklch(var(--bc) / .35)", borderWidth: node.id === selectedStageId ? 2 : 1, borderRadius: 12, padding: 16 },
  }))); }, [definition, selectedStageId]);
  const edges = useMemo(() => funnelEdges(definition).map(edge => ({ id: edge.id, source: edge.from ?? ENTRY, target: edge.to,
    label: edge.label, type: "smoothstep", deletable: false, style: { stroke: "oklch(var(--bc) / .6)" }, labelStyle: { fill: "oklch(var(--bc))", fontSize: 11 }, labelBgStyle: { fill: "oklch(var(--b1))" } })), [definition]);
  const changes = useCallback((items: NodeChange[]) => {
    // Selection changes emitted by user interaction also cover keyboard selection.
    // Observing the controlled selection itself feeds old nodes back into new props.
    const selection = items.find(item => item.type === "select" && item.selected && item.id !== ENTRY);
    if (!disabled && selection?.type === "select" && selection.id !== selectedStageId) onSelectStage(selection.id);
    setNodes(old => applyNodeChanges(items.filter(item => item.type !== "remove"), old));
  }, [ENTRY, disabled, onSelectStage, selectedStageId]);
  return <section data-funnel-canvas aria-label="Funnel canvas" className="rounded-box border border-base-300 overflow-hidden min-w-0">
    <div className="p-3 flex flex-wrap gap-3 items-center bg-base-200"><button className={buttonClass} type="button" onClick={() => { const arranged = arrange(definition); setNodes(old => old.map(node => ({ ...node, position: arranged.find(item => item.id === node.id)?.position ?? node.position }))); requestAnimationFrame(() => flow?.fitView({ padding: .2, duration: 0 })); }}>Arrange stages</button>
      <p className="text-xs max-w-xl">Drag to arrange. Positions last for this visit only; save stores the rules. Connecting opens a rule form. All editing is also available below.</p></div>
    <div className="h-[440px] sm:h-[520px] w-full" data-testid="funnel-canvas"><ReactFlow nodes={nodes} edges={edges} onNodesChange={changes} onInit={setFlow}
      onNodeClick={(_, node) => { if (!disabled && node.id !== ENTRY) onSelectStage(node.id); }}
      onConnect={connection => { if (connection.source && connection.target) onConnect(connection.source === ENTRY ? null : connection.source, connection.target); }}
      isValidConnection={connection => Boolean(connection.source && connection.target && !connectionIssue(definition, connection.source === ENTRY ? null : connection.source, connection.target))}
      nodesConnectable={!disabled} nodesDraggable={!disabled} nodesFocusable={!disabled} elementsSelectable={!disabled} edgesReconnectable={false} deleteKeyCode={null} fitView minZoom={.2} maxZoom={1.6}
      ariaLabelConfig={{ "controls.zoomIn.ariaLabel": "Zoom in on funnel", "controls.zoomOut.ariaLabel": "Zoom out of funnel", "controls.fitView.ariaLabel": "Fit all funnel stages" }}>
      <Background /><Controls showInteractive={false} /></ReactFlow></div>
  </section>;
}
