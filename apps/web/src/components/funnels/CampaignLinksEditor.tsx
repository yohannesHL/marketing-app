"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { FunnelDefinition, FunnelStageAction } from "../../server/funnels/funnelDefinition";
import type { UiCampaign } from "./funnelUi";

const control = "select select-bordered min-h-11 w-full min-w-0 bg-base-100";
const button = "btn btn-ghost min-h-11 h-auto whitespace-normal normal-case";
function SecondsField({ label, value, minimum, disabled, onChange, onValidityChange }: {
  label: string; value: number; minimum: number; disabled?: boolean; onChange: (value: number) => void; onValidityChange: (valid: boolean) => void;
}) {
  const id = useId(), [raw, setRaw] = useState(String(value));
  const validityCallback = useRef(onValidityChange); validityCallback.current = onValidityChange;
  useEffect(() => { setRaw(String(value)); }, [value]);
  const good = /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) && Number(raw) >= minimum && Number(raw) <= 31536000;
  useEffect(() => { onValidityChange(good); }, [good, onValidityChange]);
  useEffect(() => () => validityCallback.current(true), []);
  return <div className="grid gap-1"><label className="text-sm font-medium" htmlFor={id}>{label}</label>
    <input id={id} type="text" inputMode="numeric" className="input input-bordered min-h-11 w-full min-w-0 bg-base-100" value={raw} disabled={disabled}
      aria-invalid={!good} aria-describedby={!good ? `${id}-error` : undefined} onChange={event => {
        const next = event.target.value; setRaw(next); if (/^\d+$/.test(next) && Number.isSafeInteger(Number(next)) && Number(next) >= minimum && Number(next) <= 31536000) onChange(Number(next));
      }} />{!good && <p id={`${id}-error`} className="text-sm text-error">Enter whole seconds from {minimum.toLocaleString()} to 31,536,000.</p>}</div>;
}

export function CampaignLinksEditor({ definition, onChange, stageId, campaigns, disabled, onValidityChange }: {
  definition: FunnelDefinition; onChange: (definition: FunnelDefinition) => void; stageId: string; campaigns: UiCampaign[]; disabled?: boolean; onValidityChange?: (valid: boolean) => void;
}) {
  const [linkChoice, setLinkChoice] = useState(""), [actionChoice, setActionChoice] = useState(""), [kind, setKind] = useState<"EMAIL_ENROLL" | "EMAIL_STOP">("EMAIL_ENROLL");
  const [invalid, setInvalid] = useState<Record<string, boolean>>({});
  const links = (definition.campaignLinks ?? []).filter(link => link.stageId === stageId), actions = (definition.stageActions ?? []).filter(action => action.stageId === stageId);
  const activeKeys = new Set(actions.flatMap(action => [`${action.id}:delay`, `${action.id}:expiry`]));
  const valid = !Object.entries(invalid).some(([key, value]) => activeKeys.has(key) && value);
  useEffect(() => { onValidityChange?.(valid); }, [valid, onValidityChange]);
  const report = (key: string, good: boolean) => setInvalid(previous => Boolean(previous[key]) === !good ? previous : { ...previous, [key]: !good });
  const update = (action: FunnelStageAction) => onChange({ ...definition, stageActions: (definition.stageActions ?? []).map(item => item.id === action.id ? action : item) });
  const available = campaigns.filter(campaign => campaign.category === "EMAIL" && campaign.status === "ACTIVE" && campaign.publishedRevisionId);
  const linkOptions = campaigns.filter(campaign => campaign.status !== "ARCHIVED" && !links.some(link => link.campaignId === campaign.id));
  const actionOptions = available.filter(campaign => !actions.some(action => action.campaignId === campaign.id));
  return <section className="grid min-w-0 gap-5" aria-label="Connected campaigns and optional actions">
    <div className="grid gap-3"><div><h3 className="font-semibold">Connected campaigns</h3><p className="mt-1 text-sm text-base-content/70">Connect campaigns for attribution. A connection alone never enrolls anyone or sends a message.</p></div>
      {!links.length && <p className="text-sm text-base-content/70">No campaigns connected to this stage.</p>}
      {links.map(link => { const campaign = campaigns.find(item => item.id === link.campaignId); return <div key={link.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-box border border-base-300 p-3">
        <div className="min-w-0 break-words"><p className="font-medium">{campaign?.name ?? "Unavailable campaign"}</p><p className="text-xs text-base-content/70">{campaign?.category ?? "Unknown category"} · Attribution only{campaign?.status === "ARCHIVED" ? " · Archived" : ""}</p></div>
        <button type="button" className={button} disabled={disabled} aria-label={`Disconnect ${campaign?.name ?? "unavailable campaign"} attribution`} onClick={() => onChange({ ...definition, campaignLinks: (definition.campaignLinks ?? []).filter(item => item.id !== link.id) })}>Disconnect</button>
      </div>; })}
      <label className="grid gap-1 text-sm font-medium">Connect another campaign<select className={control} disabled={disabled || !linkOptions.length} value={linkChoice} onChange={event => setLinkChoice(event.target.value)}>
        <option value="">Choose a campaign</option>{linkOptions.map(campaign => <option key={campaign.id} value={campaign.id}>{campaign.name} · {campaign.category}</option>)}</select></label>
      <button type="button" className={`${button} justify-self-start`} disabled={disabled || !linkOptions.some(campaign => campaign.id === linkChoice) || (definition.campaignLinks?.length ?? 0) >= 512} onClick={() => {
        onChange({ ...definition, campaignLinks: [...(definition.campaignLinks ?? []), { id: crypto.randomUUID(), stageId, campaignId: linkChoice, purpose: "ATTRIBUTION" }] }); setLinkChoice("");
      }}>Connect for attribution</button>
    </div>
    <div className="grid gap-3"><div><h3 className="font-semibold">Optional actions on entry</h3><p className="mt-1 text-sm text-base-content/70">Actions need explicit funnel and campaign enablement. Enrollment uses a pinned campaign revision; the campaign controls its message sequence.</p></div>
      {!actions.length && <p className="text-sm text-base-content/70">Tracking only. No entry actions are configured.</p>}
      {actions.map((action, index) => { const campaign = campaigns.find(item => item.id === action.campaignId), usable = available.some(item => item.id === action.campaignId);
        return <fieldset key={action.id} className="grid min-w-0 gap-3 rounded-box border border-base-300 p-3"><legend className="px-1 font-semibold">Action {index + 1}</legend>
          <label className="grid gap-1 text-sm font-medium">Action<select className={control} disabled={disabled} value={action.kind} onChange={event => {
            const base = { id: action.id, stageId, campaignId: action.campaignId };
            update(event.target.value === "EMAIL_STOP" ? { ...base, kind: "EMAIL_STOP" } : { ...base, kind: "EMAIL_ENROLL", revisionId: campaign?.publishedRevisionId ?? "",
              delaySeconds: 0, expiresAfterDueSeconds: 604800, stopOnStageExit: true, stopOnGoal: true });
          }}><option value="EMAIL_ENROLL" disabled={!usable && action.kind !== "EMAIL_ENROLL"}>Enroll in email campaign</option><option value="EMAIL_STOP">Stop this journey’s stage enrollment</option></select></label>
          <label className="grid gap-1 text-sm font-medium">Email campaign<select className={control} disabled={disabled} value={action.campaignId} onChange={event => {
            const next = available.find(item => item.id === event.target.value); if (next) update({ ...action, campaignId: next.id,
              ...(action.kind === "EMAIL_ENROLL" ? { revisionId: next.publishedRevisionId! } : {}) });
          }}>{!usable && <option value={action.campaignId}>{campaign?.name ?? "Unavailable campaign"} · unavailable</option>}
            {available.filter(item => item.id === action.campaignId || !actions.some(existing => existing.campaignId === item.id)).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          {!usable && <p className="text-sm text-warning">Choose an active, published email campaign before publishing this action.</p>}
          {campaign && <p className="text-xs text-base-content/70">Campaign enrollment {campaign.enrolmentEnabled ? "enabled" : "off"} · Message dispatch {campaign.dispatchEnabled ? "enabled" : "off"}</p>}
          {action.kind === "EMAIL_ENROLL" ? <>
            <label className="grid gap-1 text-sm font-medium">Pinned campaign revision<select className={control} disabled={disabled || !usable} value={action.revisionId} onChange={event => update({ ...action, revisionId: event.target.value })}>
              {action.revisionId !== campaign?.publishedRevisionId && <option value={action.revisionId}>Previously pinned revision · {action.revisionId}</option>}
              {campaign?.publishedRevisionId && <option value={campaign.publishedRevisionId}>Current published revision · {campaign.publishedRevisionId}</option>}</select></label>
            <SecondsField label="Delay before campaign enrollment (seconds)" minimum={0} value={action.delaySeconds} disabled={disabled} onChange={delaySeconds => update({ ...action, delaySeconds })} onValidityChange={good => report(`${action.id}:delay`, good)} />
            <SecondsField label="Enrollment expires after becoming due (seconds)" minimum={1} value={action.expiresAfterDueSeconds} disabled={disabled} onChange={expiresAfterDueSeconds => update({ ...action, expiresAfterDueSeconds })} onValidityChange={good => report(`${action.id}:expiry`, good)} />
            <label className="flex min-h-11 items-start gap-3 py-2 text-sm"><input type="checkbox" className="checkbox checkbox-primary" disabled={disabled} checked={action.stopOnStageExit} onChange={event => update({ ...action, stopOnStageExit: event.target.checked })} /><span>Stop this stage’s enrollment when the journey leaves this stage.</span></label>
            <label className="flex min-h-11 items-start gap-3 py-2 text-sm"><input type="checkbox" className="checkbox checkbox-primary" disabled={disabled} checked={action.stopOnGoal} onChange={event => update({ ...action, stopOnGoal: event.target.checked })} /><span>Stop after the journey reaches any goal, including an earlier goal.</span></label>
          </> : <p className="text-sm text-base-content/70">Stops stage enrollment reasons for this campaign and this journey. Independent manual enrollments remain active; submitted messages cannot be recalled.</p>}
          <button type="button" className={`${button} justify-self-start`} disabled={disabled} onClick={() => onChange({ ...definition, stageActions: (definition.stageActions ?? []).filter(item => item.id !== action.id) })} aria-label={`Remove action ${index + 1}`}>Remove action</button>
        </fieldset>;
      })}
      <fieldset className="grid gap-3 rounded-box border border-dashed border-base-300 p-3"><legend className="px-1 text-sm font-semibold">Add an action explicitly</legend>
        <label className="grid gap-1 text-sm font-medium">New action<select className={control} disabled={disabled} value={kind} onChange={event => setKind(event.target.value as typeof kind)}>
          <option value="EMAIL_ENROLL">Enroll in email campaign</option><option value="EMAIL_STOP">Stop stage enrollment</option></select></label>
        <label className="grid gap-1 text-sm font-medium">Published email campaign<select className={control} disabled={disabled || !actionOptions.length} value={actionChoice} onChange={event => setActionChoice(event.target.value)}>
          <option value="">Choose a campaign</option>{actionOptions.map(campaign => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}</select></label>
        {!actionOptions.length && <p className="text-sm text-base-content/70">Publish an email campaign to configure another supported action.</p>}
        <button type="button" className={`${button} justify-self-start`} disabled={disabled || !actionOptions.some(item => item.id === actionChoice) || (definition.stageActions?.length ?? 0) >= 512} onClick={() => {
          const campaign = actionOptions.find(item => item.id === actionChoice); if (!campaign) return;
          const base = { id: crypto.randomUUID(), stageId, campaignId: campaign.id };
          const action: FunnelStageAction = kind === "EMAIL_STOP" ? { ...base, kind } : { ...base, kind, revisionId: campaign.publishedRevisionId!, delaySeconds: 0, expiresAfterDueSeconds: 604800, stopOnStageExit: true, stopOnGoal: true };
          onChange({ ...definition, stageActions: [...(definition.stageActions ?? []), action] }); setActionChoice("");
        }}>Add optional action</button>
      </fieldset>
    </div>
  </section>;
}
