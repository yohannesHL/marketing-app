"use client";
import { useEffect, useState } from "react";
import type { FunnelDefinition, FunnelRoute } from "../../server/funnels/funnelDefinition";
import type { UiSource } from "./funnelUi";
import { ConditionEditor } from "./ConditionEditor";
import { connectionIssue, connectStages } from "./funnelGraph";

const control = "select select-bordered min-h-11 w-full min-w-0 bg-base-100";
const button = "btn btn-ghost min-h-11 h-auto whitespace-normal normal-case";
type Props = { definition: FunnelDefinition; onChange: (definition: FunnelDefinition) => void; stageId: string; sources: UiSource[]; disabled?: boolean; onValidityChange?: (valid: boolean) => void };
export function RuleEditor({ definition, onChange, stageId, sources, disabled, onValidityChange }: Props) {
  const [adding, setAdding] = useState(false), [sourceId, setSourceId] = useState(""), [eventType, setEventType] = useState("");
  const [entry, setEntry] = useState(false), [destination, setDestination] = useState(""), [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<Record<string, boolean>>({}), [notice, setNotice] = useState("");
  const stage = definition.stages.find(item => item.id === stageId), source = sources.find(item => item.id === sourceId);
  const visible = definition.routes.filter(route => route.from === stageId || route.from === null &&
    (route.branches.some(branch => branch.to === stageId) || route.fallback.kind === "MOVE" && route.fallback.to === stageId));
  const branchIds = new Set(visible.flatMap(route => route.branches.map(branch => branch.id)));
  const valid = !Object.entries(invalid).some(([key, value]) => value && branchIds.has(key));
  useEffect(() => { onValidityChange?.(valid); }, [valid, onValidityChange]);
  const update = (next: FunnelRoute) => onChange({ ...definition, routes: definition.routes.map(route => route.id === next.id ? next : route) });
  const report = (key: string, good: boolean) => setInvalid(previous => Boolean(previous[key]) === !good ? previous : { ...previous, [key]: !good });
  const targets = (from: string | null) => definition.stages.filter(item => !connectionIssue(definition, from, item.id));
  const reorder = (route: FunnelRoute, direction: -1 | 1) => {
    const index = definition.routes.findIndex(item => item.id === route.id), at = index + direction, routes = [...definition.routes];
    if (at < 0 || at >= routes.length) return;
    [routes[index], routes[at]] = [routes[at], routes[index]]; onChange({ ...definition, routes }); setNotice(`Rule moved to position ${at + 1}.`);
  };
  if (!stage) return null;
  return <section aria-label="Routing rules" className="grid min-w-0 gap-4">
    <div><h3 className="font-semibold">Routing rules</h3><p className="mt-1 text-sm text-base-content/70">The first matching event rule runs. Its branches are checked in order; an unknown condition waits. Diagram position does not change this order.</p></div>
    <p role="status" className="text-sm text-base-content/70">{notice}</p>
    {!visible.length && <p className="text-sm text-base-content/70">No event rules for this stage. Manual moves remain available.</p>}
    {visible.map(route => {
      const index = definition.routes.findIndex(item => item.id === route.id), selected = sources.find(item => item.id === route.trigger.sourceId);
      const choices = targets(route.from), fields = selected?.config.propertyKeys ?? [];
      const branchMove = (at: number, direction: -1 | 1) => { const branches = [...route.branches], to = at + direction; if (to < 0 || to >= branches.length) return;
        [branches[at], branches[to]] = [branches[to], branches[at]]; update({ ...route, branches }); setNotice(`Branch moved to position ${to + 1}.`); };
      const targetOptions = (value: string) => <>{!choices.some(item => item.id === value) && <option value={value}>{definition.stages.find(item => item.id === value)?.name ?? value} · unavailable</option>}
        {choices.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</>;
      return <fieldset key={route.id} className="grid min-w-0 gap-3 rounded-box border border-base-300 p-3">
        <legend className="px-1 font-semibold">Rule {index + 1} · {route.from === null ? "Enter this funnel" : "Leave this stage"}</legend>
        <div className="flex flex-wrap gap-1">
          <button type="button" className={button} disabled={disabled || index === 0} onClick={() => reorder(route, -1)} aria-label={`Move rule ${index + 1} earlier`}>Move up</button>
          <button type="button" className={button} disabled={disabled || index === definition.routes.length - 1} onClick={() => reorder(route, 1)} aria-label={`Move rule ${index + 1} later`}>Move down</button>
          <button type="button" className={button} disabled={disabled} onClick={() => { onChange({ ...definition, routes: definition.routes.filter(item => item.id !== route.id) }); setNotice(`Rule ${index + 1} removed.`); }} aria-label={`Remove rule ${index + 1}`}>Remove rule</button>
        </div>
        <label className="grid gap-1 text-sm font-medium">Data source<select className={control} disabled={disabled} value={route.trigger.sourceId} onChange={event => {
          const next = sources.find(item => item.id === event.target.value); if (!next) return;
          update({ ...route, trigger: { ...route.trigger, sourceId: next.id, type: next.config.allowedEvents.includes(route.trigger.type) ? route.trigger.type : next.config.allowedEvents[0] ?? route.trigger.type } });
        }}>{!selected && <option value={route.trigger.sourceId}>Unavailable source ({route.trigger.sourceId})</option>}
          {sources.map(item => <option key={item.id} value={item.id}>{item.name}{item.status !== "ACTIVE" ? " · unavailable" : ""}</option>)}</select></label>
        {selected?.status !== "ACTIVE" && <p className="text-sm text-warning">This source is unavailable. Repair it before publishing this rule.</p>}
        <label className="grid gap-1 text-sm font-medium">Event<select className={control} disabled={disabled} value={route.trigger.type} onChange={event => update({ ...route, trigger: { ...route.trigger, type: event.target.value } })}>
          {!selected?.config.allowedEvents.includes(route.trigger.type) && <option value={route.trigger.type}>{route.trigger.type} · unavailable</option>}
          {selected?.config.allowedEvents.map(type => <option key={type} value={type}>{type}</option>)}</select></label>
        <label className="grid gap-1 text-sm font-medium">Run when<select className={control} disabled={disabled} value={route.trigger.kind} onChange={event => {
          const base = { sourceId: route.trigger.sourceId, type: route.trigger.type };
          update({ ...route, trigger: event.target.value === "EVENT" ? { ...base, kind: "EVENT" } : { ...base, kind: "PROPERTY_CHANGE", key: fields[0] ?? "" } });
        }}><option value="EVENT">This event occurs</option><option value="PROPERTY_CHANGE" disabled={!fields.length}>An observed property changes</option></select></label>
        {route.trigger.kind === "PROPERTY_CHANGE" && <label className="grid gap-1 text-sm font-medium">Changed property<select className={control} disabled={disabled} value={route.trigger.key} onChange={event => update({ ...route, trigger: { ...route.trigger, kind: "PROPERTY_CHANGE", key: event.target.value } })}>
          {!fields.includes(route.trigger.key) && <option value={route.trigger.key}>{route.trigger.key} · unavailable</option>}{fields.map(key => <option key={key} value={key}>{key}</option>)}</select></label>}
        {route.branches.map((branch, branchIndex) => <fieldset key={branch.id} className="grid min-w-0 gap-3 rounded-box border border-base-300 p-3">
          <legend className="px-1 text-sm font-semibold">Branch {branchIndex + 1}</legend>
          <label className="grid gap-1 text-sm font-medium">Go to stage<select className={control} disabled={disabled} value={branch.to} onChange={event => update({ ...route, branches: route.branches.map(item => item.id === branch.id ? { ...item, to: event.target.value } : item) })}>{targetOptions(branch.to)}</select></label>
          <ConditionEditor value={branch.when} fields={fields} sources={sources} label={`Rule ${index + 1}, branch ${branchIndex + 1}`} disabled={disabled} onValidityChange={good => report(branch.id, good)} onChange={when => update({ ...route, branches: route.branches.map(item => {
            if (item.id !== branch.id) return item; const { when: _old, ...base } = item; return when ? { ...base, when } : base;
          }) })} />
          <div className="flex flex-wrap gap-1">
            <button type="button" className={button} disabled={disabled || branchIndex === 0} onClick={() => branchMove(branchIndex, -1)} aria-label={`Move branch ${branchIndex + 1} of rule ${index + 1} earlier`}>Move up</button>
            <button type="button" className={button} disabled={disabled || branchIndex === route.branches.length - 1} onClick={() => branchMove(branchIndex, 1)} aria-label={`Move branch ${branchIndex + 1} of rule ${index + 1} later`}>Move down</button>
            <button type="button" className={button} disabled={disabled} onClick={() => update({ ...route, branches: route.branches.filter(item => item.id !== branch.id) })} aria-label={`Remove branch ${branchIndex + 1} from rule ${index + 1}`}>Remove branch</button>
          </div>
        </fieldset>)}
        <button type="button" className={`${button} justify-self-start`} disabled={disabled || !choices.length || route.branches.length >= 256} onClick={() => update({ ...route, branches: [...route.branches, { id: crypto.randomUUID(), to: choices[0].id }] })}>Add ordered branch</button>
        <label className="grid gap-1 text-sm font-medium">If no branch matches<select className={control} disabled={disabled} value={route.fallback.kind} onChange={event => update({ ...route, fallback: event.target.value === "WAIT" ? { kind: "WAIT" } : { kind: "MOVE", to: choices[0].id } })}>
          <option value="WAIT">Wait at this stage</option><option value="MOVE" disabled={!choices.length}>Move to another stage</option></select></label>
        {route.fallback.kind === "MOVE" && <label className="grid gap-1 text-sm font-medium">Fallback stage<select className={control} disabled={disabled} value={route.fallback.to} onChange={event => update({ ...route, fallback: { kind: "MOVE", to: event.target.value } })}>{targetOptions(route.fallback.to)}</select></label>}
      </fieldset>;
    })}
    {adding ? <fieldset className="grid min-w-0 gap-3 rounded-box border border-base-300 p-3"><legend className="px-1 font-semibold">New event rule</legend>
      <label className="grid gap-1 text-sm font-medium">Rule starts<select className={control} disabled={disabled} value={entry ? "ENTRY" : "STAGE"} onChange={event => { setEntry(event.target.value === "ENTRY"); setDestination(""); }}>
        <option value="STAGE" disabled={stage.terminal !== "NONE"}>At {stage.name}</option><option value="ENTRY" disabled={!definition.entryStages.includes(stageId)}>Before funnel entry</option></select></label>
      <label className="grid gap-1 text-sm font-medium">Data source<select className={control} disabled={disabled} value={sourceId} onChange={event => { setSourceId(event.target.value); setEventType(""); }}>
        <option value="">Choose a source</option>{sources.map(item => <option key={item.id} value={item.id} disabled={item.status !== "ACTIVE"}>{item.name}{item.status !== "ACTIVE" ? " · unavailable" : ""}</option>)}</select></label>
      <label className="grid gap-1 text-sm font-medium">Event<select className={control} disabled={disabled || !source} value={eventType} onChange={event => setEventType(event.target.value)}>
        <option value="">Choose an event</option>{source?.config.allowedEvents.map(type => <option key={type} value={type}>{type}</option>)}</select></label>
      <label className="grid gap-1 text-sm font-medium">Go to stage<select className={control} disabled={disabled} value={entry ? stageId : destination} onChange={event => setDestination(event.target.value)}>
        <option value="">Choose a stage</option>{(entry ? [stage] : targets(stageId)).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      {error && <p role="alert" className="text-sm text-error">{error}</p>}
      <div className="flex flex-wrap gap-2"><button type="button" className="btn btn-primary min-h-11 normal-case" disabled={disabled || !source || !eventType || !entry && !destination} onClick={() => {
        try { onChange(connectStages(definition, { id: crypto.randomUUID(), from: entry ? null : stageId, to: entry ? stageId : destination, sourceId, type: eventType })); setAdding(false); setError(null); setNotice("Event rule added. Add branches to refine it."); }
        catch (failure) { setError(failure instanceof Error ? failure.message : "Check the rule settings."); }
      }}>Add rule</button><button type="button" className={button} disabled={disabled} onClick={() => setAdding(false)}>Cancel</button></div>
    </fieldset> : <button type="button" className={`${button} justify-self-start`} disabled={disabled || definition.routes.length >= 512 || stage.terminal !== "NONE" && !definition.entryStages.includes(stageId)} onClick={() => { setEntry(stage.terminal !== "NONE"); setAdding(true); }}>Add event rule</button>}
  </section>;
}
