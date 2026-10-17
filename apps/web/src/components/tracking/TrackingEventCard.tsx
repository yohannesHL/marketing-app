"use client";
import { useId, useState } from "react";
import { Button } from "@launchpad/ui";
import { TrackingBadge as Badge } from "./TrackingBadge";
import { dateLabel, EVENT_STATUS, subjectLabel, type SourceSummary, type TrackingEvent, type TrackingSubject } from "./trackingUi";
export function TrackingEventCard({ event, source, subjects, busy, onAction }: { event: TrackingEvent; source: SourceSummary; subjects: TrackingSubject[]; busy: boolean;
  onAction: (path: string, body: unknown, notice: string) => Promise<void> }) {
  const [subjectId, setSubjectId] = useState(""), [reason, setReason] = useState(""), id = useId();
  const eligible = subjects.filter(subject => event.evidence?.authority === "BROWSER_OBSERVED" || !event.evidence?.subjectKind || subject.kind === event.evidence.subjectKind);
  const prefix = `/api/tracking/sources/${source.id}/events/${event.id}`;
  return <article id={`event-${event.id}`} className="min-w-0 rounded-box border border-base-300 bg-base-100 p-4 space-y-3" data-testid="tracking-event">
    <div className="flex flex-wrap items-center gap-2"><h3 className="text-lg font-semibold break-all">{event.type}</h3><Badge tone={event.status === "MATCHED" ? "success" : ["QUARANTINED", "BLOCKED"].includes(event.status) ? "warning" : "neutral"}>{EVENT_STATUS[event.status] ?? event.status}</Badge><Badge>{event.processingMode}</Badge>{event.late && <Badge tone="warning">Late occurrence</Badge>}</div>
    <dl className="grid gap-2 text-sm sm:grid-cols-2"><div><dt>Occurred</dt><dd>{dateLabel(event.occurredAt)}</dd></div><div><dt>Received</dt><dd>{dateLabel(event.receivedAt)}</dd></div><div className="min-w-0"><dt>Subject</dt><dd className="break-all">{event.subjectId ?? "Not matched"}</dd></div><div><dt>Repeated deliveries</dt><dd>{event.duplicates} duplicate · {event.conflicts} conflicting</dd></div></dl>
    {event.reason && <p className="break-words">Reason: <code>{event.reason}</code></p>}
    <details><summary className="cursor-pointer min-h-11 py-2 font-medium">Inspect identity and evidence</summary><div className="space-y-3 pt-2"><p className="break-all text-sm">Receipt: {event.id}</p>{event.evidence ? <>
      <p>{event.evidence.authority} · {event.evidence.verification}</p><p className="break-all"><strong>Business reference:</strong> {event.evidence.resource ? `${event.evidence.resource.kind}: ${event.evidence.resource.id}` : "Not supplied"}</p>
      {event.evidence.references?.length ? <ul className="space-y-1">{event.evidence.references.map((ref, n) => <li className="break-all text-sm" key={n}>{ref.kind}: {ref.id}</li>)}</ul> : null}
      <div className="min-w-0"><h4 className="font-medium">Normalized properties</h4><pre className="mt-2 whitespace-pre-wrap break-all rounded-box bg-base-200 p-3 text-sm">{JSON.stringify(event.evidence.properties ?? {}, null, 2)}</pre></div>
    </> : <p>This evidence was removed. It cannot be restored or replayed.</p>}</div></details>
    {source.provider !== "RESEND" && event.status === "UNMATCHED" && <details><summary className="cursor-pointer min-h-11 py-2 font-medium">Match to an existing subject</summary>
      <form className="grid gap-3 pt-2" onSubmit={e => { e.preventDefault(); void onAction(`${prefix}/match`, { subjectId: subjectId.trim(), reason: reason.trim() }, "Manual matching queued as history-only replay. Refresh after the worker processes it."); }}>
        <p>Choose the verified enquiry, purchase or person this event belongs to. This is an audited history correction and does not start campaigns.</p>
        <label className="grid gap-2" htmlFor={`${id}-subject`}><span>Owned subject ID ({event.evidence?.subjectKind?.toLowerCase() ?? "compatible kind"})</span><input id={`${id}-subject`} list={`${id}-subjects`} required className="input input-bordered min-h-11 w-full bg-base-100" value={subjectId} onChange={e => setSubjectId(e.target.value)} maxLength={128} /><datalist id={`${id}-subjects`}>{eligible.map(subject => <option key={subject.id} value={subject.id}>{subjectLabel(subject)}</option>)}</datalist><span className="text-sm">Suggestions include up to 100 recent subjects. You can paste another owned ID in {source.environment}.</span></label>
        <label className="grid gap-2"><span>Why this match is correct</span><textarea required maxLength={500} className="textarea textarea-bordered w-full bg-base-100" rows={2} value={reason} onChange={e => setReason(e.target.value)} /></label>
        <Button type="submit" className="min-h-11 justify-self-start" disabled={busy || !subjectId.trim() || !reason.trim()}>Queue audited match</Button>
      </form></details>}
    {source.provider !== "RESEND" && !["REDACTED", "QUARANTINED", "QUEUED"].includes(event.status) && <details><summary className="cursor-pointer min-h-11 py-2 font-medium">History-only recovery</summary><p>Reprocess retained evidence against current mappings. Replay cannot create retrospective campaign enrolment or satisfy a sending wait.</p><Button variant="secondary" className="mt-3 min-h-11" disabled={busy || source.status !== "ACTIVE"} onClick={() => void onAction(`${prefix}/replay`, {}, "History-only replay queued. Refresh after processing.")}>Queue history replay</Button></details>}
    {source.provider === "RESEND" && <p className="text-sm">Use the saved email send to reconcile this managed evidence.</p>}
  </article>;
}
