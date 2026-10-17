"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createFunnelTemplate, type FunnelTemplateKind } from "../../server/funnels/funnelTemplates";
import { FunnelLayout } from "./FunnelLayout";
import { funnelRequest, inputClass, message, panelClass, type Environment, type UiFunnel, type UiSource } from "./funnelUi";
export function FunnelCreate({ initialEnvironment = "TEST" }: { initialEnvironment?: Environment }) {
  const router = useRouter(), [environment, setEnvironment] = useState(initialEnvironment), [name, setName] = useState("");
  const [kind, setKind] = useState<FunnelTemplateKind>("blank"), [subjectKind, setSubjectKind] = useState("SALES");
  const [sources, setSources] = useState<UiSource[]>([]), [primary, setPrimary] = useState(""), [booking, setBooking] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  useEffect(() => { let active = true; setSources([]); setPrimary(""); setBooking("");
    funnelRequest<UiSource[]>(`/api/tracking/sources?environment=${environment}`).then(value => { if (active) setSources(value); }).catch(e => { if (active) setError(message(e)); }); return () => { active = false; }; }, [environment]);
  async function create(event: React.FormEvent) { event.preventDefault(); setBusy(true); setError(null);
    try { const definition = createFunnelTemplate(kind, kind === "blank" ? undefined : { primarySourceId: primary, ...(booking && kind === "sales" ? { bookingSourceId: booking } : {}) });
      const saved = await funnelRequest<UiFunnel>("/api/funnels", "POST", { name, environment, subjectKind, definition }); router.push(`/funnels/${saved.id}`);
    } catch (e) { setError(message(e)); setBusy(false); } }
  return <FunnelLayout title="Create a funnel" description="Templates are starting points. Every stage, branch, goal and campaign can be changed." environment={environment} busy={busy} error={error} onError={e => setError(message(e))}>
    <form onSubmit={create} className={`${panelClass} max-w-3xl space-y-5`}><fieldset disabled={busy} className="space-y-5">
      <label className="block">Funnel name<input required maxLength={120} className={inputClass} value={name} onChange={e => setName(e.target.value)} /></label>
      <div className="grid sm:grid-cols-2 gap-4"><label>Environment<select className={inputClass} value={environment} onChange={e => setEnvironment(e.target.value as Environment)}><option>TEST</option><option>LIVE</option></select></label>
        <label>Count a journey for<select className={inputClass} value={subjectKind} onChange={e => setSubjectKind(e.target.value)}><option value="SALES">Each sales enquiry</option><option value="PURCHASE">Each purchase journey</option><option value="SUBSCRIPTION">Each subscription</option><option value="CONTACT">Each person</option></select></label></div>
      <label className="block">Starting template<select className={inputClass} value={kind} onChange={e => { const value = e.target.value as FunnelTemplateKind; setKind(value); if (value === "sales") setSubjectKind("SALES"); if (value === "ecommerce") setSubjectKind("PURCHASE"); if (value === "subscription" || value === "subscription-activation") setSubjectKind("SUBSCRIPTION"); if (value === "subscription-activation") setPrimary(""); }}>
        <option value="blank">Blank · define your own journey</option><option value="sales">Sales · enquiry to won or lost</option><option value="ecommerce">Ecommerce · verified purchase and refund</option><option value="events">Events · registration and attendance</option><option value="subscription-activation">Subscription activation · Fluxsoft active subscriptions</option><option value="subscription">Subscription trial funnel · trial, setup and conversion</option></select></label>
      {kind !== "blank" && <><p className="text-sm">Bind the template to a source now. Review its event names before publishing; templates never create evidence or send messages.</p>
        <label className="block">Primary data source<select required className={inputClass} value={primary} onChange={e => setPrimary(e.target.value)}><option value="">Choose a source</option>{sources.filter(s => s.status === "ACTIVE" && (kind !== "subscription-activation" || s.provider === "API" && s.config.allowedEvents.includes("custom.fluxsoft.subscription_active"))).map(s => <option key={s.id} value={s.id}>{s.name} · {s.provider}</option>)}</select></label>
        {kind === "sales" && <label className="block">Booking source (optional)<select className={inputClass} value={booking} onChange={e => setBooking(e.target.value)}><option value="">No booking stage yet</option>{sources.filter(s => s.config.allowedEvents.includes("booking.confirmed")).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>}
        <Link href="/tracking" className="underline inline-block">Set up a data source</Link></>}
      {kind === "subscription-activation" && <p className="text-sm">Starts directly at Subscription active when the connected server reports custom.fluxsoft.subscription_active. Choose an API source that allows this event. This template does not infer a trial, setup activity, renewals or invoice amounts.</p>}
      {kind === "subscription" && <p className="text-sm">Use this trial funnel only when your application reports the trial, setup, feature-use, subscription and cancellation events shown in its rules. The Fluxsoft activation bridge does not supply those trial events.</p>}
      {kind === "ecommerce" && <p className="text-sm">This template starts at verified payment. Add earlier website stages only when you have evidence that can be matched to the same purchase journey.</p>}
      <p className="text-sm">New drafts start with automation off. Each enquiry, purchase or subscription remains separate even when the contact is the same.</p>
      <button className="btn btn-primary min-h-11 normal-case" type="submit">Create draft</button>
    </fieldset></form>
  </FunnelLayout>;
}
