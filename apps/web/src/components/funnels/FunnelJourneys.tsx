"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { buttonClass, dateLabel, funnelRequest, inputClass, key, message, panelClass, type UiFunnel, type UiJourney, type UiVersion } from "./funnelUi";
type Subject = { id: string; kind: string; contact?: { name?: string | null; email?: string | null }; references?: { kind: string; externalId: string }[] };
type History = { journey: UiJourney; version: UiVersion; subject: Subject;
  transitions: { id: string; sequence: number; fromStageKey: string | null; toStageKey: string; ruleId: string | null; mode: string; triggerKind: string;
    reasonCode: string; note: string | null; occurredAt: string; recordedAt: string; evaluationTrace: unknown; event?: { id: string; sourceId: string; type: string; authority: string; status: string } | null }[];
  effects: { id: string; outcome: string; ruleId: string | null; createdAt: string }[];
  actions: { id: string; kind: string; status: string; reason: string | null; dueAt: string; expiresAt: string; membershipId: string | null }[];
  associations: { id: string; membershipId: string; kind: string; endedAt: string | null; endReason: string | null }[] };
export function FunnelJourneys({ funnel, initialJourneyId, activity = false }: { funnel: UiFunnel; initialJourneyId?: string; activity?: boolean }) {
  const [journeys, setJourneys] = useState<UiJourney[]>([]), [cursor, setCursor] = useState<string | null>(null), [subjects, setSubjects] = useState<Subject[]>([]);
  const [selected, setSelected] = useState(initialJourneyId ?? ""), [history, setHistory] = useState<History | null>(null), [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [notice, setNotice] = useState(""), [refresh, setRefresh] = useState(0);
  const [subjectId, setSubjectId] = useState(""), [stageId, setStageId] = useState(""), [reason, setReason] = useState(""), [newCycle, setNewCycle] = useState(false);
  const generation = useRef(0), command = useRef<{ payload: string; key: string } | null>(null);
  useEffect(() => { let active = true; setLoading(true); setError(null);
    Promise.all([funnelRequest<{ journeys: UiJourney[]; nextCursor: string | null }>(`/api/funnels/${funnel.id}/journeys`), funnelRequest<Subject[]>(`/api/tracking/subjects?environment=${funnel.environment}`)])
      .then(([value, people]) => { if (active) { setJourneys(value.journeys); setCursor(value.nextCursor); setSubjects(people.filter(s => s.kind === funnel.subjectKind)); if (activity) setSelected(old => old || value.journeys[0]?.id || ""); } })
      .catch(e => { if (active) setError(message(e)); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [funnel.id, funnel.environment, funnel.subjectKind, refresh, activity]);
  useEffect(() => { const token = ++generation.current; setHistory(null); setStageId(""); setReason(""); setNewCycle(false);
    if (selected) funnelRequest<History>(`/api/funnels/${funnel.id}/journeys/${selected}/history`).then(value => { if (token === generation.current) { setHistory(value); setSubjectId(value.journey.subjectId); } }).catch(e => { if (token === generation.current) setError(message(e)); });
    return () => { generation.current++; }; }, [selected, funnel.id, refresh]);
  const stageName = useCallback((id: string, versionId?: string) => (history && history.version.id === versionId ? history.version : funnel.versions?.find(v => v.id === versionId))?.definition.stages.find(s => s.id === id)?.name ?? id, [funnel.versions, history]);
  const definition = history && !newCycle ? history.version.definition : funnel.versions?.find(v => v.id === funnel.publishedVersionId)?.definition;
  async function more() { if (!cursor) return; setBusy(true); try { const value = await funnelRequest<{ journeys: UiJourney[]; nextCursor: string | null }>(`/api/funnels/${funnel.id}/journeys?cursor=${encodeURIComponent(cursor)}`);
    setJourneys(old => [...old, ...value.journeys.filter(j => !old.some(p => p.id === j.id))]); setCursor(value.nextCursor); } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  async function move(event: React.FormEvent) { event.preventDefault(); setBusy(true); setError(null); setNotice("");
    const payload = { subjectId, stageId, reason, newCycle, ...(history ? { expectedJourneyId: history.journey.id, expectedRevision: history.journey.revision } : {}) }, digest = JSON.stringify(payload);
    if (command.current?.payload !== digest) command.current = { payload: digest, key: key("move") };
    try { const value = await funnelRequest<{ journey: UiJourney }>(`/api/funnels/${funnel.id}/move`, "POST", { ...payload, commandKey: command.current.key });
      setSelected(value.journey.id); setRefresh(n => n + 1); setNotice("Manual move recorded with your reason. No new automation was started."); command.current = null;
    } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  async function cancel() { if (!history || !reason.trim()) { setError("Enter a reason before cancelling this journey."); return; } setBusy(true); setError(null);
    try { await funnelRequest(`/api/funnels/${funnel.id}/journeys/${history.journey.id}/cancel`, "POST", { reason }); setRefresh(n => n + 1); setNotice("Journey cancelled. Already accepted messages cannot be recalled."); }
    catch (e) { setError(message(e)); } finally { setBusy(false); } }
  return <div className="space-y-5">{error && <p role="alert" className="border border-error rounded-box p-3">{error}</p>}{notice && <p role="status">{notice}</p>}
    <div className="flex flex-wrap gap-3 justify-between items-center"><h2 className="text-xl font-semibold">{activity ? "Journey activity" : "People and business journeys"}</h2><button className={buttonClass} disabled={busy} onClick={() => setRefresh(n => n + 1)}>Refresh journeys</button></div>
    <p className="text-sm">Each enquiry or purchase has its own journey and history. The same person may appear more than once. A new cycle is counted separately.</p>
    {loading ? <p role="status">Loading journeys…</p> : !journeys.length ? <p className={panelClass}>No journeys yet. Publish the funnel and connect matching evidence, or record an explicit manual entry below.</p> :
      <ul className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">{journeys.map(journey => { const subject = journey.subject ?? subjects.find(s => s.id === journey.subjectId); return <li key={journey.id} className={`${panelClass} ${selected === journey.id ? "ring-2 ring-primary" : ""}`}><h3 className="font-semibold break-words">{subject?.contact?.name || subject?.contact?.email || funnel.subjectKind}</h3>
        <p className="text-sm break-all mt-1">Subject {journey.subjectId} · cycle {journey.cycle}</p><p className="mt-2">{stageName(journey.currentStageKey, journey.versionId)} · {journey.status}</p><p className="text-sm">Entered {dateLabel(journey.startedAt)}</p>
        <button className={`${buttonClass} mt-3`} disabled={busy} onClick={() => setSelected(journey.id)} aria-pressed={selected === journey.id}>Inspect journey {journey.cycle}</button></li>; })}</ul>}
    {cursor && <button className={buttonClass} disabled={busy} onClick={more}>Load more journeys</button>}
    {selected && !history && <p role="status">Loading pinned history…</p>}
    {history && <section className={`${panelClass} space-y-5`} aria-label="Journey history"><div><h2 className="text-xl font-semibold">Journey history · version {history.version.number}</h2><p className="text-sm break-all">{history.subject.contact?.name || history.subject.contact?.email || history.subject.kind} · {history.journey.subjectId} · cycle {history.journey.cycle}</p><p className="text-sm">Published {dateLabel(history.version.publishedAt)}. This journey retains this version when the draft changes.</p><Link prefetch={false} className="btn btn-ghost min-h-11 normal-case" href={`/funnels/${funnel.id}?view=results&versionId=${history.version.id}`}>Results for this version</Link></div>
      <ol className="space-y-4">{history.transitions.map(t => <li key={t.id} className="border-l-4 border-primary pl-4 break-words"><h3 className="font-semibold">{t.sequence}. {t.fromStageKey ? stageName(t.fromStageKey, history.version.id) : "Before entry"} → {stageName(t.toStageKey, history.version.id)}</h3>
        <p>{t.triggerKind} · {t.mode} · {t.reasonCode}</p>{t.note && <p>Reason: {t.note}</p>}<p className="text-sm">Occurred {dateLabel(t.occurredAt)} · Recorded {dateLabel(t.recordedAt)}{t.ruleId && ` · Rule ${t.ruleId}`}</p>
        {t.event && <p className="text-sm"><Link className="underline" href={`/tracking/${t.event.sourceId}?environment=${funnel.environment}&event=${t.event.id}#event-inbox`}>{t.event.type} · {t.event.status} · {t.event.authority}</Link></p>}
        <details><summary className="min-h-11 cursor-pointer pt-2">Explain this transition</summary><pre className="whitespace-pre-wrap break-words text-xs">{JSON.stringify(t.evaluationTrace, null, 2)}</pre></details></li>)}</ol>
      <section><h3 className="font-semibold">Automation actions</h3>{!history.actions.length ? <p className="text-sm">No automation actions were captured for this journey.</p> : <ul className="space-y-2 mt-2">{history.actions.map(action => <li key={action.id} className="break-words"><p>{action.kind} · {action.status} · {action.reason ?? "Waiting for processing"}</p><p className="text-sm">Due {dateLabel(action.dueAt)} · Expires {dateLabel(action.expiresAt)}</p>{action.membershipId && <Link className="underline" href={`/email/memberships/${action.membershipId}`}>Inspect campaign steps and delivery attempts</Link>}</li>)}</ul>}</section>
      <section><h3 className="font-semibold">Campaign associations</h3><ul>{history.associations.map(a => <li key={a.id} className="break-words"><Link className="underline" href={`/email/memberships/${a.membershipId}`}>{a.kind} association · {a.endedAt ? `Ended: ${a.endReason}` : "Active"}</Link></li>)}</ul></section>
      <details><summary className="min-h-11 cursor-pointer">Recent evaluated evidence (up to 100)</summary><ul className="text-sm space-y-2">{history.effects.map(e => <li key={e.id}>{dateLabel(e.createdAt)} · {e.outcome} · {e.ruleId ?? "No eligible rule"}</li>)}</ul></details>
    </section>}
    <form className={`${panelClass} space-y-4`} onSubmit={move}><h2 className="text-xl font-semibold">Record a manual correction or entry</h2><p className="text-sm">Manual moves update tracking and stop obsolete work. They do not start new campaigns. Finished journeys require an explicit new cycle.</p>
      <fieldset disabled={busy || !funnel.publishedVersionId} className="space-y-4"><label className="block">Subject<select required className={inputClass} value={subjectId} disabled={Boolean(history)} onChange={e => setSubjectId(e.target.value)}><option value="">Choose an owned subject</option>{subjects.map(s => <option key={s.id} value={s.id}>{s.contact?.name || s.contact?.email || s.kind} · {s.id}</option>)}{history && !subjects.some(s => s.id === history.journey.subjectId) && <option value={history.journey.subjectId}>{history.journey.subjectId}</option>}</select></label>
        {history && <button type="button" className={buttonClass} onClick={() => { setSelected(""); setSubjectId(""); }}>Choose a different subject</button>}
        <label className="flex gap-3 items-center"><input type="checkbox" className="checkbox" checked={newCycle} onChange={e => { setNewCycle(e.target.checked); setStageId(""); }} />Explicitly start a new cycle after a finished journey</label>
        <label className="block">Destination stage<select required className={inputClass} value={stageId} onChange={e => setStageId(e.target.value)}><option value="">Choose a stage</option>{definition?.stages.filter(s => history && !newCycle ? true : definition.entryStages.includes(s.id)).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label className="block">Reason<textarea required maxLength={500} className="textarea textarea-bordered w-full min-h-24" value={reason} onChange={e => setReason(e.target.value)} /></label>
        <div className="flex flex-wrap gap-3"><button type="submit" className="btn btn-primary min-h-11 normal-case">Record tracking-only move</button>{history && history.journey.status !== "CANCELLED" && <button type="button" className="btn btn-outline min-h-11 normal-case" onClick={cancel}>Cancel this journey with reason</button>}</div>
      </fieldset>{!funnel.publishedVersionId && <p>Publish the funnel before entering a subject.</p>}
    </form>
  </div>;
}
