"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Card } from "@launchpad/ui";
import { SourceForm, OneTimeValue } from "./SourceForm";
import { SourceEvidence } from "./SourceInspector";
import { SourceInstallation, SourceTools } from "./SourceTools";
import { TrackingEventCard } from "./TrackingEventCard";
import { TrackingLayout } from "./TrackingLayout";
import { dateLabel, trackingError, trackingRequest, trackingSignIn, type EventPage, type SourceSummary, type TrackingAudit, type TrackingEnvironment, type TrackingEvent, type TrackingSubject } from "./trackingUi";
export function TrackingSourceDetail({ sourceId, expectedEnvironment, requestedEvent }: { sourceId: string; expectedEnvironment?: string; requestedEvent?: string }) {
  const [source, setSource] = useState<SourceSummary | null>(null), [events, setEvents] = useState<TrackingEvent[]>([]), [next, setNext] = useState<string | null>(null);
  const [subjects, setSubjects] = useState<TrackingSubject[]>([]), [audit, setAudit] = useState<TrackingAudit[]>([]), [selected, setSelected] = useState<TrackingEvent | null>(null);
  const [loading, setLoading] = useState(true), [paging, setPaging] = useState(false), [busy, setBusy] = useState(false), [formPending, setFormPending] = useState(false);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [status, setStatus] = useState("ACTIVE");
  const [reviewChange, setReviewChange] = useState(false), [reviewRotate, setReviewRotate] = useState(false), [ingress, setIngress] = useState<string | null>(null);
  const epoch = useRef(0), pending = useRef(false);
  const load = useCallback(async (initial = true) => {
    const current = ++epoch.current; if (initial) setLoading(true); setError(null);
    try {
      const expected = expectedEnvironment;
      const result = await trackingRequest<SourceSummary>(`/api/tracking/sources/${encodeURIComponent(sourceId)}${expected ? `?environment=${encodeURIComponent(expected)}` : ""}`);
      const query = `environment=${result.environment}&order=newest`, requested = requestedEvent;
      const [page, people, logs, highlighted] = await Promise.all([
        trackingRequest<EventPage>(`/api/tracking/sources/${sourceId}/events?${query}`),
        trackingRequest<TrackingSubject[]>(`/api/tracking/subjects?environment=${result.environment}`),
        trackingRequest<TrackingAudit[]>(`/api/tracking/sources/${sourceId}/audit`),
        requested ? trackingRequest<EventPage>(`/api/tracking/sources/${sourceId}/events?${query}&eventId=${encodeURIComponent(requested)}`) : Promise.resolve(null),
      ]);
      if (current !== epoch.current) return;
      setSource(result); setStatus(result.status); setEvents(page.events); setNext(page.nextCursor); setSubjects(people); setAudit(logs); setSelected(highlighted?.events[0] ?? null);
    } catch (failure) { if (current === epoch.current) { if (initial) { setSource(null); setEvents([]); setSubjects([]); } if (!trackingSignIn(failure)) setError(trackingError(failure)); } }
    finally { if (current === epoch.current) setLoading(false); }
  }, [sourceId, expectedEnvironment, requestedEvent]);
  useEffect(() => { setSource(null); setIngress(null); setSelected(null); void load(); return () => { epoch.current++; }; }, [load]);
  async function mutate<T>(path: string, body: unknown, message: string, method = "POST"): Promise<T | null> {
    if (pending.current || formPending) return null;
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    const current = epoch.current;
    try {
      const result = await trackingRequest<T>(path, method, body);
      if (current !== epoch.current) return null;
      setNotice(message); await load(false); return result;
    } catch (failure) { if (current === epoch.current && !trackingSignIn(failure)) setError(trackingError(failure)); return null; }
    finally { pending.current = false; setBusy(false); }
  }
  async function action(path: string, body: unknown, message: string) { await mutate(path, body, message); }
  async function more() {
    if (!source || !next || paging) return;
    setPaging(true); setError(null); const current = epoch.current;
    try { const page = await trackingRequest<EventPage>(`/api/tracking/sources/${sourceId}/events?environment=${source.environment}&order=newest&cursor=${encodeURIComponent(next)}`);
      if (current === epoch.current) { setEvents(rows => [...rows, ...page.events.filter(item => !rows.some(row => row.id === item.id))]); setNext(page.nextCursor); } }
    catch (failure) { if (current === epoch.current && !trackingSignIn(failure)) setError(trackingError(failure)); }
    finally { setPaging(false); }
  }
  const environment: TrackingEnvironment = source?.environment ?? (expectedEnvironment === "LIVE" ? "LIVE" : "TEST");
  return <TrackingLayout title={source?.name ?? "Source diagnostics"} description="Inspect received evidence, matching and source setup before using it in a funnel." environment={environment} loading={loading} busy={busy || formPending} error={error} notice={notice}>
    {source ? <>
      <div className="flex flex-wrap gap-2"><a className="btn btn-ghost min-h-11 normal-case" href="#event-inbox">Event inbox</a><a className="btn btn-ghost min-h-11 normal-case" href="#source-settings">Source settings</a><a className="btn btn-ghost min-h-11 normal-case" href="#source-audit">Audit history</a><Button variant="secondary" className="min-h-11" disabled={busy || formPending || paging} onClick={() => void load(false)}>Refresh diagnostics</Button></div>
      <Card><h2 className="text-xl font-semibold">Source evidence</h2><SourceEvidence source={source} /><p className="text-sm break-all">Source ID: {source.id} · Generation {source.generation}</p></Card>
      {ingress && <OneTimeValue label="New provider webhook URL" value={ingress} onDismiss={() => setIngress(null)} />}
      <section id="event-inbox" className="min-w-0 space-y-4 scroll-mt-4"><h2 className="text-2xl font-semibold">Event inbox</h2><p>Newest receipts first. Received time and business occurrence are shown separately. A stored receipt may still be waiting for its matching worker.</p>
        {selected && !events.some(event => event.id === selected.id) && <div className="space-y-2"><h3 className="font-semibold">Requested receipt</h3><TrackingEventCard event={selected} source={source} subjects={subjects} busy={busy || formPending} onAction={action} /></div>}
        {events.length ? events.map(event => <TrackingEventCard key={event.id} event={event} source={source} subjects={subjects} busy={busy || formPending} onAction={action} />) : <Alert title="No receipts yet" tone="info">Complete source setup, then inspect an actual submitted form or provider event. A simulation in the funnel builder does not create receipts here.</Alert>}
        {next && <Button variant="secondary" className="min-h-11" disabled={busy || formPending} loading={paging} onClick={() => void more()}>Load older events</Button>}
      </section>
      <Card><details><summary className="min-h-11 cursor-pointer py-2 text-xl font-semibold">Installation instructions</summary><div className="pt-4"><SourceInstallation source={source} /></div></details></Card>
      {["CALENDLY", "SHOPIFY"].includes(source.provider) && <Card><SourceTools key={source.id} source={source} subjects={subjects} busy={busy || formPending} onAction={action}
        onCorrelation={subjectId => mutate(`/api/tracking/sources/${sourceId}/correlations`, { subjectId }, "Correlation created. Confirm the booking page returns utm_content before relying on it.")} /></Card>}
      <section id="source-settings" className="space-y-4 scroll-mt-4"><h2 className="text-2xl font-semibold">Source settings</h2>
        {source.provider === "RESEND" ? <Alert title="Managed email source" tone="info">This source is managed through its email connection. Its callbacks must correlate with saved sends. Generic source credentials, matching and replay are unavailable. <Link className="link" href={`/email/connections?environment=${source.environment}`}>Open email connections</Link>.</Alert> : <>
          <Card><details><summary className="min-h-11 cursor-pointer py-2 text-lg font-semibold">Edit configuration and credentials</summary><div className="pt-4"><SourceForm key={`${source.id}:${source.generation}`} source={source} environment={source.environment} onSaved={() => load(false)} disabled={busy} onPendingChange={setFormPending} /></div></details></Card>
          <Card><h3 className="text-lg font-semibold">Source availability</h3><form className="grid gap-3" onSubmit={async e => { e.preventDefault(); await mutate(`/api/tracking/sources/${sourceId}`, { status }, "Source availability updated. Existing captured waits keep their original generation.", "PATCH"); setReviewChange(false); }}>
            <label className="grid gap-2"><span>Availability</span><select className="select select-bordered min-h-11 w-full bg-base-100" value={status} onChange={e => { setStatus(e.target.value); setReviewChange(false); }}><option value="ACTIVE">Active: accept matching traffic</option><option value="PAUSED">Paused: stop accepting traffic</option><option value="DISCONNECTED">Disconnected</option></select></label>
            {status !== source.status && <><Alert title="Review source change" tone="warning">This advances the source generation. Queued old evidence can be blocked, and existing event waits will not automatically adopt the new generation. No data or provider webhook is deleted.</Alert><label className="flex min-h-11 items-center gap-3"><input type="checkbox" className="checkbox checkbox-sm shrink-0" checked={reviewChange} onChange={e => setReviewChange(e.target.checked)} />I understand the effect on queued evidence and waits.</label></>}
            <Button type="submit" variant="secondary" className="min-h-11 justify-self-start" disabled={busy || formPending || status === source.status || !reviewChange}>Save availability</Button>
          </form></Card>
          {["CALENDLY", "SHOPIFY"].includes(source.provider) && <Card><h3 className="text-lg font-semibold">Replace webhook URL</h3><p>Use this only to replace a lost or exposed URL. The old URL stops resolving. Update the provider subscription with the one-time replacement and verify a new receipt.</p><label className="flex min-h-11 items-center gap-3"><input type="checkbox" className="checkbox checkbox-sm shrink-0" checked={reviewRotate} onChange={e => setReviewRotate(e.target.checked)} />I will update the provider webhook after rotation.</label><Button variant="secondary" className="min-h-11 justify-self-start" disabled={busy || formPending || !reviewRotate} onClick={async () => {
            const result = await mutate<{ ingressToken: string }>(`/api/tracking/sources/${sourceId}`, { rotateIngress: true }, "Webhook URL rotated. Copy the new value and update the provider subscription.", "PATCH");
            if (result) setIngress(`${window.location.origin}/api/tracking/hooks/${result.ingressToken}`); setReviewRotate(false);
          }}>Rotate webhook URL</Button></Card>}
        </>}
      </section>
      <section id="source-audit" className="space-y-4 scroll-mt-4"><h2 className="text-2xl font-semibold">Audit history</h2><p>Latest 100 source actions and recovery decisions.</p>{audit.length ? <ol className="space-y-3">{audit.map(item => <li key={item.id} className="rounded-box border border-base-300 p-4 min-w-0"><p className="font-semibold break-words">{item.action}</p><p>{dateLabel(item.createdAt)}</p><p className="break-words">{item.reason}</p>{item.eventId && <p className="text-sm break-all">Receipt {item.eventId}</p>}</li>)}</ol> : <p>No audited recovery actions yet.</p>}</section>
    </> : !loading && <Button variant="secondary" className="min-h-11" onClick={() => void load()}>Retry source lookup</Button>}
  </TrackingLayout>;
}
