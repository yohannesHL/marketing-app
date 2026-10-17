"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { Condition, FunnelDefinition } from "../../server/funnels/funnelDefinition";
import { ConditionEditor } from "./ConditionEditor";
import { addStage, connectStages, connectionIssue, forkRoute, funnelEdges, insertStageOnEdge } from "./funnelGraph";
import { buttonClass, inputClass, key, message, type UiSource } from "./funnelUi";

export type CanvasConnectionRequest = { from: string | null; to?: string; edgeId?: string };
type Mode = "stage" | "connect" | "insert" | "fork";

export function CanvasConnectionDialog({ request, definition, sources, onApply, onClose }: {
  request: CanvasConnectionRequest; definition: FunnelDefinition; sources: UiSource[];
  onApply: (definition: FunnelDefinition, selected: string) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), headingId = useId();
  const edge = funnelEdges(definition).find(item => item.id === request.edgeId);
  const outgoing = definition.routes.filter(route => route.from === request.from);
  const [mode, setMode] = useState<Mode | null>(request.to ? "connect" : null);
  const [name, setName] = useState(""), [to, setTo] = useState(request.to ?? ""), [useExisting, setUseExisting] = useState(false);
  const [sourceId, setSourceId] = useState(""), [eventType, setEventType] = useState("");
  const [routeId, setRouteId] = useState(edge?.routeId ?? outgoing[0]?.id ?? ""), [when, setWhen] = useState<Condition>();
  const [conditionValid, setConditionValid] = useState(true), [error, setError] = useState<string | null>(null);
  const source = sources.find(item => item.id === sourceId), route = outgoing.find(item => item.id === routeId);
  const forkSource = sources.find(item => item.id === route?.trigger.sourceId);
  const fromName = definition.stages.find(stage => stage.id === request.from)?.name ?? "New journey";
  const toName = definition.stages.find(stage => stage.id === edge?.to)?.name;
  const title = mode === "insert" ? "Insert a stage" : mode === "fork" ? "Add a conditional stage" : mode === "stage" ? "Add a connected stage" : mode === "connect" ? "Connect stages" : "Choose the next step";
  useEffect(() => {
    const element = dialog.current, previous = document.activeElement as HTMLElement | null;
    element?.showModal();
    return () => { element?.close(); previous?.focus({ preventScroll: true }); };
  }, []);
  const choices = definition.stages.filter(stage => !connectionIssue(definition, request.from, stage.id));
  const createsStage = mode === "stage" || mode === "insert" || mode === "fork" && !useExisting;
  const needsEvidence = mode !== "fork";
  const ready = mode && (createsStage ? name.trim() && definition.stages.length < 256 : to) &&
    (needsEvidence ? source?.status === "ACTIVE" && source.config.allowedEvents.includes(eventType) : route && when && conditionValid);
  function apply() {
    if (!mode || !ready) return;
    try {
      const stage = { id: key("stage"), name: name.trim() };
      let next = definition, selected = to;
      if (mode === "insert") {
        if (!edge) throw new Error("This connection no longer exists.");
        next = insertStageOnEdge(next, { edgeId: edge.id, stage, routeId: key("route"), sourceId, type: eventType }); selected = stage.id;
      } else {
        if (createsStage) {
          next = addStage(next, stage, request.from ?? undefined); selected = stage.id;
          if (request.from === null && !next.entryStages.includes(stage.id)) next = { ...next, entryStages: [...next.entryStages, stage.id] };
        }
        next = mode === "fork" ? forkRoute(next, { routeId, branchId: key("branch"), to: selected, when: when!,
          ...(edge?.routeId === routeId && edge.branchId ? { beforeBranchId: edge.branchId } : {}) }) :
          connectStages(next, { id: key("route"), from: request.from, to: selected, sourceId, type: eventType });
      }
      onApply(next, selected);
    } catch (failure) { setError(message(failure)); }
  }
  return <dialog ref={dialog} aria-labelledby={headingId} className="funnel-connection-dialog" onCancel={onClose}>
    <div className="funnel-connection-heading"><div><p className="funnel-inspector-kicker">{fromName}{edge ? ` → ${toName}` : " · next step"}</p><h2 id={headingId}>{title}</h2></div>
      <button type="button" className={buttonClass} onClick={onClose} aria-label="Close connection editor">✕</button></div>
    {!mode ? <div className="funnel-connection-options">
      {edge ? <button type="button" onClick={() => setMode("insert")}><strong>Insert a stage</strong><span>Add a milestone between these two stages.</span></button> : <>
        <button type="button" onClick={() => setMode("stage")}><strong>Add stage</strong><span>Create a milestone and connect it with an event.</span></button>
        <button type="button" disabled={!choices.length} onClick={() => setMode("connect")}><strong>Connect to an existing stage</strong><span>Choose a destination without dragging a connector.</span></button>
      </>}
      <button type="button" disabled={!outgoing.length} onClick={() => setMode("fork")}><strong>Conditional stage</strong><span>{outgoing.length ? "Send people to a stage when they match your conditions." : "Connect a stage first, then add a conditional stage."}</span></button>
    </div> : <form className="funnel-connection-form" onSubmit={event => { event.preventDefault(); apply(); }}>
      {mode === "fork" && <>
        <label>When this event happens<select className={inputClass} value={routeId} onChange={event => { setRouteId(event.target.value); setWhen(undefined); }}>
          {outgoing.map(item => <option key={item.id} value={item.id}>{item.trigger.type} · Rule {definition.routes.indexOf(item) + 1}</option>)}
        </select></label>
        <label>Conditional destination<select className={inputClass} value={useExisting ? "existing" : "new"} onChange={event => { setUseExisting(event.target.value === "existing"); setTo(""); }}>
          <option value="new">Create a new stage</option><option value="existing" disabled={!choices.length}>Go to an existing stage</option>
        </select></label>
      </>}
      {createsStage ? <label>New stage name<input className={inputClass} maxLength={256} value={name} onChange={event => setName(event.target.value)} required /></label> :
        <label>Destination stage<select className={inputClass} value={to} onChange={event => setTo(event.target.value)} required><option value="">Choose a stage</option>{choices.map(stage => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select></label>}
      {needsEvidence ? <>
        <p className="funnel-connection-explanation">{mode === "insert" ? `The existing rule will lead into your new stage. Choose the later event that moves it on to ${toName}.` : "Choose the event that moves a journey along this connection."}</p>
        <label>Connection source<select className={inputClass} value={sourceId} onChange={event => { setSourceId(event.target.value); setEventType(""); }} required>
          <option value="">Choose source</option>{sources.map(item => <option key={item.id} value={item.id} disabled={item.status !== "ACTIVE"}>{item.name}{item.status !== "ACTIVE" ? " · unavailable" : ""}</option>)}
        </select></label>
        <label>Connection event<select className={inputClass} value={eventType} disabled={!source} onChange={event => setEventType(event.target.value)} required>
          <option value="">Choose event</option>{source?.config.allowedEvents.map(type => <option key={type}>{type}</option>)}
        </select></label>
        {!sources.some(item => item.status === "ACTIVE") && <p role="status">Connect a tracking source from Tracking sources, then refresh the source choices in Funnel details.</p>}
      </> : <>
        <p className="funnel-connection-explanation">When this condition matches, take the new path. It is checked {edge?.branchId ? "before the selected branch" : "before the otherwise path"}. Existing branch order and destinations are preserved. Unknown values wait.</p>
        <ConditionEditor value={when} onChange={setWhen} onValidityChange={setConditionValid} fields={forkSource?.config.propertyKeys ?? []} sources={sources} label="Stage condition" />
        {!when && <p className="text-sm">Add a condition to define who reaches this stage.</p>}
      </>}
      {error && <p role="alert" className="text-error">{error}</p>}
      <div className="funnel-connection-footer"><button type="submit" className="btn btn-primary min-h-11 normal-case" disabled={!ready}>{mode === "insert" ? "Insert stage" : mode === "fork" ? "Add conditional stage" : mode === "stage" ? "Add connected stage" : "Add connection rule"}</button>
        <button type="button" className={buttonClass} onClick={onClose}>Cancel connection</button>
        {!request.to && <button type="button" className="btn btn-ghost min-h-11 normal-case" onClick={() => { setMode(null); setError(null); }}>Back</button>}
      </div>
      <p className="text-xs text-base-content/70">Changes stay in your draft until you save. Publishing and automation remain separate.</p>
    </form>}
  </dialog>;
}
