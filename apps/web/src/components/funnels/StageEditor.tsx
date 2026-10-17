"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { FunnelDefinition, FunnelStage } from "../../server/funnels/funnelDefinition";
import type { UiCampaign, UiSource } from "./funnelUi";
import { addStage, funnelEdges, moveStage, removeStage } from "./funnelGraph";
import { RuleEditor } from "./RuleEditor";
import { CampaignLinksEditor } from "./CampaignLinksEditor";

const button = "btn btn-ghost min-h-11 h-auto whitespace-normal normal-case";
export function StageEditor({ definition, onChange, selectedStageId, onSelectStage, sources, campaigns, disabled, onValidityChange, sourceEvidence }: {
  definition: FunnelDefinition; onChange: (definition: FunnelDefinition) => void; selectedStageId: string | null;
  onSelectStage: (stageId: string | null) => void; sources: UiSource[]; campaigns: UiCampaign[]; disabled?: boolean; onValidityChange?: (valid: boolean) => void; sourceEvidence?: ReactNode;
}) {
  const [adding, setAdding] = useState(false), [newName, setNewName] = useState(""), [confirmRemove, setConfirmRemove] = useState(false);
  const [ruleValid, setRuleValid] = useState(true), [campaignValid, setCampaignValid] = useState(true), [notice, setNotice] = useState("");
  const [error, setError] = useState<string | null>(null), id = useId(), heading = useRef<HTMLHeadingElement>(null), previousSelection = useRef(selectedStageId);
  const [section, setSection] = useState<"stage" | "tracking" | "campaigns">("stage"), [sectionError, setSectionError] = useState<string | null>(null);
  const stage = definition.stages.find(item => item.id === selectedStageId), position = definition.stages.findIndex(item => item.id === selectedStageId);
  const nameValid = !stage || Boolean(stage.name.trim()) && stage.name.length <= 256 && !/[\u0000-\u001f\u007f]/.test(stage.name);
  const valid = ruleValid && campaignValid && nameValid;
  useEffect(() => { onValidityChange?.(valid); }, [valid, onValidityChange]);
  useEffect(() => {
    setConfirmRemove(false); setError(null); setRuleValid(true); setCampaignValid(true); setSection("stage"); setSectionError(null);
    // React Flow selects a focused node. Keep keyboard focus there so its own
    // arrow/selection controls remain usable instead of jumping into this form.
    if (previousSelection.current !== selectedStageId && !document.activeElement?.closest("[data-funnel-canvas]")) heading.current?.focus();
    previousSelection.current = selectedStageId;
  }, [selectedStageId]);
  const update = (patch: Partial<FunnelStage>) => { if (stage) onChange({ ...definition, stages: definition.stages.map(item => item.id === stage.id ? { ...item, ...patch } : item) }); };
  const outgoing = definition.routes.filter(route => route.from === selectedStageId), incoming = funnelEdges(definition).filter(edge => edge.to === selectedStageId);
  const entryRules = incoming.filter(edge => edge.from === null), links = definition.campaignLinks?.filter(link => link.stageId === selectedStageId).length ?? 0;
  const actions = definition.stageActions?.filter(action => action.stageId === selectedStageId).length ?? 0;
  return <section className="funnel-inspector grid min-w-0 gap-5" aria-label="Stage editor">
    <div className="funnel-inspector-heading"><div className="min-w-0"><p className="funnel-inspector-kicker">{stage ? `Stage ${position + 1} of ${definition.stages.length}` : "Your journey"}</p><h2 ref={heading} tabIndex={-1} className="break-words font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">{stage ? `${stage.name || "Unnamed stage"} settings` : "Stage settings"}</h2></div>
      <button type="button" className={button} disabled={disabled || !valid || definition.stages.length >= 256} onClick={() => { setAdding(true); setNewName(""); }}>Add stage</button></div>
    <p role="status" className="text-sm text-base-content/70">{notice}</p>
    {adding && <fieldset className="grid gap-3 rounded-box border border-base-300 p-3"><legend className="px-1 font-semibold">New custom stage</legend>
      <label className="grid gap-1 text-sm font-medium">Stage name<input className="input input-bordered min-h-11 w-full min-w-0 bg-base-100" value={newName} maxLength={256} disabled={disabled} autoFocus onChange={event => setNewName(event.target.value)} /></label>
      <p className="text-sm text-base-content/70">Choose your own business milestone. Add its event rule separately.</p>
      {error && <p role="alert" className="text-sm text-error">{error}</p>}
      <div className="flex flex-wrap gap-2"><button type="button" className="btn btn-primary min-h-11 normal-case" disabled={disabled || !newName.trim()} onClick={() => {
        try { const stageId = crypto.randomUUID(); onChange(addStage(definition, { id: stageId, name: newName.trim() }, selectedStageId ?? undefined)); onSelectStage(stageId); setAdding(false); setNotice("Stage added. Configure an event rule or use manual moves."); setError(null); }
        catch (failure) { setError(failure instanceof Error ? failure.message : "Check the stage name."); }
      }}>Add stage</button><button type="button" className={button} disabled={disabled} onClick={() => setAdding(false)}>Cancel</button></div>
    </fieldset>}
    {!stage ? <p className="text-sm text-base-content/70">Select a stage from the list or canvas, or add your first stage.</p> : <>
      <nav className="funnel-inspector-nav" aria-label="Stage settings sections">{([['stage', 'Stage'], ['tracking', 'Tracking'], ['campaigns', 'Campaigns']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={section === value} aria-controls={`${id}-${value}`} disabled={disabled} onClick={() => {
        if (!valid && value !== section) { setSectionError("Complete or remove the invalid field before changing sections. Your unfinished value is preserved."); return; }
        setSection(value); setSectionError(null);
      }}>{label}</button>)}</nav>
      {sectionError && <p role="alert" className="text-sm text-error">{sectionError}</p>}
      <div id={`${id}-stage`} className="funnel-inspector-section" hidden={section !== "stage"}>
      <div className="grid gap-1"><label htmlFor={`${id}-name`} className="text-sm font-medium">Stage name</label>
        <input id={`${id}-name`} className="input input-bordered min-h-11 w-full min-w-0 bg-base-100" value={stage.name} maxLength={256} disabled={disabled} aria-invalid={!nameValid} aria-describedby={!nameValid ? `${id}-name-error` : undefined} onChange={event => update({ name: event.target.value })} />
        {!nameValid && <p id={`${id}-name-error`} className="text-sm text-error">Enter a stage name of 1–256 characters.</p>}</div>
      <div className="grid gap-2">
        <label className="flex min-h-11 items-start gap-3 py-2 text-sm"><input type="checkbox" className="checkbox checkbox-primary" disabled={disabled || entryRules.length > 0} checked={definition.entryStages.includes(stage.id)} onChange={event => onChange({ ...definition, entryStages: event.target.checked ? [...definition.entryStages, stage.id] : definition.entryStages.filter(key => key !== stage.id) })} /><span>Allow new journeys to enter at this stage.</span></label>
        {!!entryRules.length && <p className="text-xs text-base-content/70">Remove this stage’s entry rules before disabling it as an entry.</p>}
        <label className="flex min-h-11 items-start gap-3 py-2 text-sm"><input type="checkbox" className="checkbox checkbox-primary" disabled={disabled} checked={stage.goal} onChange={event => update({ goal: event.target.checked })} /><span>Count reaching this stage as a goal. A goal can remain open for later stages.</span></label>
      </div>
      <label className="grid gap-1 text-sm font-medium">Journey exit<select className="select select-bordered min-h-11 w-full min-w-0 bg-base-100" disabled={disabled} value={stage.terminal} onChange={event => update({ terminal: event.target.value as FunnelStage["terminal"] })}>
        <option value="NONE">Keep the journey open</option><option value="SUCCESS" disabled={outgoing.length > 0}>End successfully</option><option value="FAILURE" disabled={outgoing.length > 0}>End unsuccessfully</option></select></label>
      {!!outgoing.length && <p className="text-xs text-base-content/70">Remove outgoing rules before making this an exit stage.</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={disabled || position <= 0} onClick={() => { onChange(moveStage(definition, stage.id, -1)); setNotice("Stage moved up in the list. Rule priority is unchanged."); }}>Move stage up</button>
        <button type="button" className={button} disabled={disabled || position === definition.stages.length - 1} onClick={() => { onChange(moveStage(definition, stage.id, 1)); setNotice("Stage moved down in the list. Rule priority is unchanged."); }}>Move stage down</button>
        <button type="button" className={button} disabled={disabled} onClick={() => setConfirmRemove(true)}>Remove stage</button>
      </div>
      {confirmRemove && <div className="grid gap-3 rounded-box border border-warning p-3" role="group" aria-label={`Confirm removal of ${stage.name}`}>
        <p className="text-sm">Remove {stage.name} from this draft? This removes {outgoing.length} outgoing rules, {incoming.length} incoming paths, {links} campaign links and {actions} actions. Incoming fallbacks become Wait. Published versions stay unchanged.</p>
        <div className="flex flex-wrap gap-2"><button type="button" className="btn btn-error min-h-11 normal-case" disabled={disabled} onClick={() => {
          const next = removeStage(definition, stage.id); onChange(next); onSelectStage(next.stages[Math.min(position, next.stages.length - 1)]?.id ?? null); setConfirmRemove(false); setNotice("Stage and its draft references removed.");
        }}>Confirm remove stage</button><button type="button" className={button} disabled={disabled} onClick={() => setConfirmRemove(false)}>Keep stage</button></div>
      </div>}
      </div>
      <div id={`${id}-tracking`} className="funnel-inspector-section" hidden={section !== "tracking"}>
        <RuleEditor key={`rules:${stage.id}`} definition={definition} onChange={onChange} stageId={stage.id} sources={sources} disabled={disabled} onValidityChange={setRuleValid} />
        {sourceEvidence}
      </div>
      <div id={`${id}-campaigns`} className="funnel-inspector-section" hidden={section !== "campaigns"}>
        <CampaignLinksEditor key={`campaigns:${stage.id}`} definition={definition} onChange={onChange} stageId={stage.id} campaigns={campaigns} disabled={disabled} onValidityChange={setCampaignValid} />
      </div>
    </>}
  </section>;
}
