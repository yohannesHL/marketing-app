"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Card } from "@launchpad/ui";
import { TrackingBadge as Badge } from "./TrackingBadge";
import { SourceForm } from "./SourceForm";
import { TrackingLayout } from "./TrackingLayout";
import { dateLabel, PROVIDER_LABELS, sourceLink, trackingError, trackingRequest, trackingSignIn, type SourceSummary, type TrackingEnvironment } from "./trackingUi";
export function TrackingSources() {
  const [environment, setEnvironment] = useState<TrackingEnvironment>("TEST"), [sources, setSources] = useState<SourceSummary[]>([]), [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null), [creating, setCreating] = useState(false), [query, setQuery] = useState(""), [formPending, setFormPending] = useState(false);
  const epoch = useRef(0), currentEnvironment = useRef(environment);
  currentEnvironment.current = environment;
  const load = useCallback(async () => {
    const current = ++epoch.current; setError(null); setLoading(true);
    try { const rows = await trackingRequest<SourceSummary[]>(`/api/tracking/sources?environment=${environment}`); if (current === epoch.current) setSources(rows.filter(row => row.environment === environment)); }
    catch (failure) { if (current === epoch.current && !trackingSignIn(failure)) { setSources([]); setError(trackingError(failure)); } }
    finally { if (current === epoch.current) setLoading(false); }
  }, [environment]);
  useEffect(() => { if (new URLSearchParams(window.location.search).get("environment") === "LIVE") setEnvironment("LIVE"); }, []);
  useEffect(() => { void load(); return () => { epoch.current++; }; }, [load]);
  const refreshAfterCreate = async () => {
    if (currentEnvironment.current !== environment) return;
    const current = ++epoch.current;
    const rows = await trackingRequest<SourceSummary[]>(`/api/tracking/sources?environment=${environment}`);
    if (current === epoch.current && currentEnvironment.current === environment) setSources(rows.filter(row => row.environment === environment));
  };
  function changeEnvironment(value: TrackingEnvironment) { if (formPending) return; currentEnvironment.current = value; setEnvironment(value); setSources([]); setCreating(false); window.history.replaceState(null, "", `/tracking?environment=${value}`); }
  const visible = sources.filter(source => `${source.name} ${PROVIDER_LABELS[source.provider]} ${source.externalAccountId}`.toLowerCase().includes(query.toLowerCase()));
  return <TrackingLayout title="Tracking sources" description="Connect website forms, business events and provider evidence to the right customer journey." environment={environment} signedIn={!loading} loading={false} busy={formPending} error={error}>
    <div className="flex flex-wrap items-end justify-between gap-4"><label className="grid gap-2"><span className="font-medium">Environment</span><select className="select select-bordered min-h-11 bg-base-100" value={environment} disabled={formPending} onChange={e => changeEnvironment(e.target.value as TrackingEnvironment)}><option value="TEST">TEST</option><option value="LIVE">LIVE</option></select></label>
      <div className="flex flex-wrap gap-2"><Button variant="ghost" className="min-h-11" disabled={loading || formPending} onClick={() => void load()}>Refresh sources</Button><Button className="min-h-11" disabled={formPending} onClick={() => setCreating(value => !value)} aria-expanded={creating} aria-controls="source-create">{creating ? "Close source setup" : "Connect source"}</Button></div></div>
    {creating && <Card id="source-create" title="Connect a source"><SourceForm key={environment} environment={environment} onSaved={refreshAfterCreate} onPendingChange={setFormPending} /></Card>}
    <label className="grid gap-2"><span className="font-medium">Find a source</span><input className="input input-bordered min-h-11 w-full bg-base-100" type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Name, provider or account" /></label>
    {loading ? <p role="status">Loading your sources…</p> : !visible.length ? <Alert title={sources.length ? "No matching sources" : "No sources in this environment"} tone="info">{sources.length ? "Try another name or provider." : "Connect a website form or business system, then inspect an actual received event. You can build a tracking-only funnel without email setup."}</Alert> : <ul className="grid min-w-0 gap-4 md:grid-cols-2">{visible.map(source => <li key={source.id} className="min-w-0 rounded-box border border-base-300 bg-base-100 p-5 space-y-3">
      <div className="flex flex-wrap gap-2"><Badge tone={source.status === "ACTIVE" ? "success" : "warning"}>{source.status === "ACTIVE" ? "Configured" : source.status}</Badge><Badge>{PROVIDER_LABELS[source.provider]}</Badge>{source.provider === "RESEND" && <Badge>Managed by email</Badge>}</div>
      <h2 className="text-xl font-semibold break-words"><Link className="link" href={sourceLink(source)}>{source.name}</Link></h2><p className="text-sm break-all">{source.externalAccountId}</p>
      <p>{source.health.explanation}</p><p className="text-sm">Last receipt: {dateLabel(source.health.lastReceipt?.receivedAt)}</p>
      <p>{source.health.matchedEvents} matched · {source.health.unresolvedEvents} need review</p><Link className="btn btn-secondary min-h-11 h-auto py-2 normal-case" href={sourceLink(source)}>Inspect source</Link>
    </li>)}</ul>}
    <p className="text-sm">Showing up to 100 most recently created sources in {environment}. Counts reflect retained evidence; no recent traffic can mean an idle source.</p>
  </TrackingLayout>;
}
