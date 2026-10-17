"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { FunnelLayout } from "./FunnelLayout";
import { buttonClass, dateLabel, funnelRequest, inputClass, message, panelClass, type Environment, type UiFunnel } from "./funnelUi";
export function FunnelList() {
  const [environment, setEnvironment] = useState<Environment>("TEST"), [items, setItems] = useState<UiFunnel[]>([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null);
  useEffect(() => { let active = true; setLoading(true); setError(null); setItems([]);
    funnelRequest<UiFunnel[]>(`/api/funnels?environment=${environment}`).then(value => { if (active) setItems(value); })
      .catch(error => { if (active) setError(message(error)); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [environment]);
  return <FunnelLayout title="Funnels" description="Define the journey your business needs. Connect evidence to stages, then choose whether to automate." environment={environment} error={error} onError={e => setError(message(e))}>
    <div className="flex flex-wrap items-end justify-between gap-4 mb-6"><label className="max-w-xs w-full">Environment<select className={inputClass} value={environment} onChange={e => setEnvironment(e.target.value as Environment)}><option>TEST</option><option>LIVE</option></select></label>
      <Link prefetch={false} className="btn btn-primary min-h-11 normal-case" href={`/funnels/create?environment=${environment}`}>Create funnel</Link></div>
    {loading ? <p role="status">Loading funnels…</p> : !items.length ? <section className={panelClass}><h2 className="text-xl font-semibold">Start with your customer journey</h2><p className="mt-2">Create your own stages or adapt a sales or purchase template. Tracking can run with automation off.</p></section> :
      <ul className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">{items.map(funnel => <li key={funnel.id} className={panelClass}><h2 className="text-xl font-semibold break-words"><Link prefetch={false} className="underline decoration-base-300 underline-offset-4" href={`/funnels/${funnel.id}`}>{funnel.name}</Link></h2>
        <p className="mt-2 text-sm">{funnel.subjectKind === "SALES" ? "Sales enquiries" : funnel.subjectKind === "PURCHASE" ? "Purchase journeys" : "People"} · {funnel.status}</p>
        <p className="mt-3">{funnel.draft.stages.length} stages · {funnel.publishedVersionId ? "Published" : "Draft only"}</p>
        <p className="text-sm mt-1">New automation: {funnel.automationEnrolmentEnabled ? "Enabled" : "Off"} · Sending: {funnel.automationDispatchEnabled ? "Enabled" : "Off"}</p>
        <p className="text-sm text-base-content/70 mt-3">Created {dateLabel(funnel.createdAt)}</p><Link prefetch={false} className={`${buttonClass} mt-4`} href={`/funnels/${funnel.id}`}>Open funnel</Link></li>)}</ul>}
  </FunnelLayout>;
}
