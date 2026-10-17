"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { FunnelLayout } from "./FunnelLayout";
import { buttonClass, dateLabel, funnelRequest, inputClass, message, panelClass, type Environment, type UiFunnel } from "./funnelUi";
export function FunnelList({ initialEnvironment = "TEST" }: { initialEnvironment?: Environment }) {
  const [environment, setEnvironment] = useState<Environment>(initialEnvironment), [items, setItems] = useState<UiFunnel[]>([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null);
  useEffect(() => { let active = true; setLoading(true); setError(null); setItems([]);
    funnelRequest<UiFunnel[]>(`/api/funnels?environment=${environment}`).then(value => { if (active) setItems(value); })
      .catch(error => { if (active) setError(message(error)); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [environment]);
  return <FunnelLayout title="Funnels" description="Define the journey your business needs. Connect evidence to stages, then choose whether to automate." environment={environment} error={error} onError={e => setError(message(e))}>
    <div className="flex flex-wrap items-end justify-between gap-4 mb-6"><label className="max-w-xs w-full">Environment<select className={inputClass} value={environment} onChange={e => setEnvironment(e.target.value as Environment)}><option>TEST</option><option>LIVE</option></select></label>
      <Link prefetch={false} className="btn btn-primary min-h-11 normal-case" href={`/funnels/create?environment=${environment}`}>Create funnel</Link></div>
    {loading ? <p role="status">Loading funnels…</p> : !items.length ? <section className={panelClass}><h2 className="text-xl font-semibold">Start with your customer journey</h2><p className="mt-2">Create your own stages or adapt a sales, purchase or subscription template. Tracking can run with automation off.</p></section> :
      <ul className="grid md:grid-cols-2 xl:grid-cols-3 gap-5">{items.map(funnel => <li key={funnel.id} className="funnel-list-card"><div className="flex flex-wrap justify-between gap-2 text-xs text-base-content/70"><span>{funnel.subjectKind === "SALES" ? "Sales enquiries" : funnel.subjectKind === "PURCHASE" ? "Purchase journeys" : funnel.subjectKind === "SUBSCRIPTION" ? "Subscriptions" : "People"}</span><span className="badge badge-outline">{funnel.status}</span></div>
        <h2 className="text-xl font-semibold break-words"><Link prefetch={false} className="hover:underline underline-offset-4" href={`/funnels/${funnel.id}`}>{funnel.name}</Link></h2>
        <div className="funnel-list-stages" aria-label="Draft stage preview">{funnel.draft.stages.slice(0, 4).map(stage => <span key={stage.id}>{stage.name}{stage.goal ? " · Goal" : ""}</span>)}{funnel.draft.stages.length > 4 && <span>+{funnel.draft.stages.length - 4} more</span>}</div>
        <div><p className="text-sm">{funnel.draft.stages.length} stages · {funnel.publishedVersionId ? "Published" : "Draft only"}</p><p className="text-xs text-base-content/70 mt-2">New automation: {funnel.automationEnrolmentEnabled ? "Enabled" : "Off"} · Sending: {funnel.automationDispatchEnabled ? "Enabled" : "Off"}</p></div>
        <div className="funnel-list-card-footer"><p className="text-xs text-base-content/70">Created {dateLabel(funnel.createdAt)}</p><Link prefetch={false} className={buttonClass} href={`/funnels/${funnel.id}`}>Open funnel</Link></div></li>)}</ul>}
  </FunnelLayout>;
}
