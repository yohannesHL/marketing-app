"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { FunnelReport, ReportMoneyMeasure, ReportRatio } from "../../server/funnels/funnelReportingTypes";
import { FunnelResultBoard } from "./FunnelResultBoard";
import { buttonClass, funnelRequest, inputClass, message, panelClass, type UiFunnel } from "./funnelUi";
import { reportCounts, reportDuration, reportInstant, reportLabel, reportPercent, reportUtc, reportWindow } from "./reportDisplay";

function Metric({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return <div className={panelClass}><dt className="text-sm">{label}</dt><dd className="text-2xl font-semibold mt-2 break-words">{value}</dd>{note && <dd className="text-sm mt-2">{note}</dd>}</div>;
}
function Ratio({ ratio }: { ratio: ReportRatio }) { return <>{reportPercent(ratio)} ({ratio.numerator} / {ratio.denominator})</>; }
function Money({ measure }: { measure: ReportMoneyMeasure }) {
  return <><span className="font-semibold tabular-nums break-all">{measure.valuedFacts ? measure.amount : "Not valued"}</span><span className="block text-sm">{measure.valuedFacts} valued facts · {measure.unvaluedFacts} unvalued</span></>;
}

export function FunnelResults({ funnel, initialVersionId }: { funnel: UiFunnel; initialVersionId?: string }) {
  const [window, setWindow] = useState({ from: "", to: "" }), [versionId, setVersionId] = useState(initialVersionId || funnel.publishedVersionId || "");
  const [query, setQuery] = useState<{ versionId: string; from: string; to: string } | null>(null);
  const [report, setReport] = useState<FunnelReport | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState("overview"), [refresh, setRefresh] = useState(0), generation = useRef(0);
  useEffect(() => {
    const initialWindow = reportWindow(); setWindow(initialWindow);
    const selectedVersion = initialVersionId || funnel.publishedVersionId || "";
    setVersionId(selectedVersion); setQuery({ versionId: selectedVersion, ...initialWindow });
  }, [initialVersionId, funnel.publishedVersionId]);
  useEffect(() => {
    const token = ++generation.current; setReport(null); setError(null); setLoading(true);
    if (!query) return;
    if (!query.versionId) { setLoading(false); return; }
    const params = new URLSearchParams({ versionId: query.versionId, from: reportInstant(query.from), to: reportInstant(query.to) });
    funnelRequest<FunnelReport>(`/api/funnels/${funnel.id}/reports?${params}`).then(value => { if (generation.current === token) setReport(value); })
      .catch(e => { if (generation.current === token) setError(message(e)); }).finally(() => { if (generation.current === token) setLoading(false); });
    return () => { generation.current++; };
  }, [funnel.id, query, refresh]);
  const unapplied = query && (versionId !== query.versionId || window.from !== query.from || window.to !== query.to);
  function apply(next = window) {
    try {
      const from = reportInstant(next.from), to = reportInstant(next.to);
      if (from >= to) throw new Error("The start must be before the end of the entry window.");
      if (new Date(to).getTime() > Date.now()) throw new Error("The entry window cannot end in the future.");
      setQuery({ versionId, ...next }); setRefresh(value => value + 1); setError(null);
    } catch (e) { setError(message(e)); }
  }
  const knownVersions = funnel.versions ?? [], extraVersion = versionId && !knownVersions.some(v => v.id === versionId);
  return <section className="space-y-5" aria-label="Funnel results">
    <header><h2 className="text-2xl font-semibold">Funnel results</h2><p className="mt-2">Recorded outcomes for one published version. Count journeys and business objects separately; inspect the evidence behind each result.</p></header>
    {!funnel.publishedVersionId && !initialVersionId ? <p className={panelClass}>Publish a funnel to report its recorded journeys. A draft or simulation does not create conversion evidence.</p> : <>
      <form className={`${panelClass} space-y-4`} aria-label="Result filters" onSubmit={event => { event.preventDefault(); apply(); }}>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <label className="block min-w-0">Published version<select className="select select-bordered w-full min-w-0 min-h-11" value={versionId} onChange={event => setVersionId(event.target.value)}>
            {extraVersion && <option value={versionId}>{report?.version.id === versionId ? `Version ${report.version.number}` : "Version from journey history"}</option>}
            {knownVersions.map(version => <option key={version.id} value={version.id}>Version {version.number}{version.id === funnel.publishedVersionId ? " · current" : ""}</option>)}
          </select></label>
          <label className="block min-w-0">Entered from (UTC)<input className={inputClass} type="datetime-local" step="1" required value={window.from} onChange={event => setWindow(old => ({ ...old, from: event.target.value }))} /></label>
          <label className="block min-w-0">Entered before (UTC)<input className={inputClass} type="datetime-local" step="1" required value={window.to} onChange={event => setWindow(old => ({ ...old, to: event.target.value }))} /></label>
        </div>
        <p className="text-sm">Includes the start; excludes the end. Entry at any configured stage counts. Later outcomes are observed through the current snapshot.</p>
        <div className="flex flex-wrap gap-3"><button className="btn btn-primary min-h-11 normal-case" disabled={loading}>Apply filters</button><button type="button" className={buttonClass} disabled={loading} onClick={() => { const next = reportWindow(); setWindow(next); apply(next); }}>Last 30 days</button></div>
        {unapplied && <p role="status">Filters changed. Apply them to update the results below.</p>}
      </form>
      {error && <p role="alert" className="border border-error rounded-box p-4">{error}</p>}
      {loading && <p role="status">Loading funnel results…</p>}
      {report && <>
        <div className={`${panelClass} text-sm space-y-2`} aria-label="Applied report window"><p><strong>Version {report.version.number} · {report.funnel.environment}</strong> · {report.totals.journeys} journey cycles</p><p>Entered from {reportUtc(report.cohort.from)} to before {reportUtc(report.cohort.to)}.</p><p>Observed through {reportUtc(report.cohort.asOf)}. This is a current snapshot, not a historical reconstruction.</p></div>
        <nav aria-label="Result views" className="flex flex-wrap gap-2">{[["overview", "Overview"], ["campaigns", "Campaign results"], ["board", "Stage board"]].map(([key, label]) => <button key={key} className={`btn min-h-11 normal-case ${tab === key ? "btn-primary" : "btn-ghost"}`} aria-pressed={tab === key} onClick={() => setTab(key)}>{label}</button>)}</nav>
        {report.totals.journeys === 0 && <p className={panelClass}>No journeys entered this version in the selected window. A zero denominator has no conversion rate; missing evidence is not a zero-value sale.</p>}
        {tab === "overview" && <Overview report={report} />}
        {tab === "campaigns" && <CampaignResults report={report} />}
        {tab === "board" && <FunnelResultBoard key={`${report.version.id}:${report.cohort.asOf}`} report={report} />}
      </>}
    </>}
  </section>;
}

function Overview({ report }: { report: FunnelReport }) {
  const total = report.totals, stageName = (id: string | null) => id ? report.stages.find(stage => stage.stageId === id)?.name ?? id : "Before entry";
  return <div className="space-y-6">
    <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Journey totals">
      <Metric label="Journey cycles" value={total.journeys} note={`${total.repeatCycles} additional cycles for the same subjects`} />
      <Metric label="Distinct subjects" value={total.distinctSubjects} note="Enquiries, purchases, subscriptions or people; not a unique-contact count" />
      <Metric label="Reached any goal" value={`${reportPercent(total.goalRate)} (${total.goalJourneys} / ${total.journeys})`} note="A goal can remain active for later stages" />
      <Metric label="Active / pending" value={total.active} note="Unfinished journeys are not assumed abandoned" />
      <Metric label="Succeeded" value={total.succeeded} note="Recorded successful terminal outcomes" />
      <Metric label="Failed" value={total.failed} note="Recorded unsuccessful terminal outcomes" />
      <Metric label="Cancelled" value={total.cancelled} note="Explicitly ended journeys" />
      <Metric label="Median time to first goal" value={reportDuration(total.timeToFirstGoal.medianMs)} note={`${total.timeToFirstGoal.count} valid observed intervals`} />
    </dl>
    <section className="space-y-3" aria-label="Stage progression"><h3 className="text-xl font-semibold">Stage progression</h3><p className="text-sm">Current occupancy includes finished journeys. Unique reach counts each cycle once per stage; visits include re-entry. Completed residence and current age use recorded transition times.</p>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{report.stages.map(stage => <section key={stage.stageId} className={`${panelClass} space-y-3`} aria-label={`Stage: ${stage.name}`}>
        <h4 className="font-semibold break-words">{stage.name}</h4><p className="text-sm">{[stage.entry ? "Entry" : null, stage.goal ? "Goal" : null, stage.terminal !== "NONE" ? reportLabel(stage.terminal) : null].filter(Boolean).join(" · ") || "Intermediate stage"}</p>
        <dl className="grid grid-cols-2 gap-3"><div><dt>Ever reached</dt><dd className="text-2xl font-semibold">{stage.everReachedJourneys}</dd></div><div><dt>Current journeys</dt><dd className="text-2xl font-semibold">{stage.currentJourneys}</dd></div><div><dt>Active here</dt><dd>{stage.activeJourneys}</dd></div><div><dt>Known exits here</dt><dd>{stage.knownExitJourneys}</dd></div><div><dt>Entered here</dt><dd>{stage.entryJourneys}</dd></div><div><dt>Visits</dt><dd>{stage.visits}</dd></div></dl>
        <p className="text-sm">Reach: <Ratio ratio={stage.reachRate} /> · Moved on: {stage.movedOnJourneys}</p><p className="text-sm">Manual entries: {stage.manualEntryJourneys} · Manual visits: {stage.manualVisits}</p>
        <p className="text-sm">Median completed residence: {reportDuration(stage.completedResidence.medianMs)} ({stage.completedResidence.count} intervals).</p><p className="text-sm">Median current age: {reportDuration(stage.openResidence.medianMs)} ({stage.openResidence.count} open visits; still running).</p>
      </section>)}</div>
    </section>
    <section className={`${panelClass} space-y-3`} aria-label="Goal conversions"><h3 className="text-xl font-semibold">Goal conversions</h3>{report.goals.length ? <ul className="space-y-3">{report.goals.map(goal => <li key={goal.stageId}><strong>{goal.name}</strong>: <Ratio ratio={goal.conversion} /> · Median first reach {reportDuration(goal.timeToFirstReach.medianMs)} ({goal.timeToFirstReach.count} intervals)</li>)}</ul> : <p>No goal stages were configured in this version.</p>}<p className="text-sm">One cycle can reach several goals. The overall goal rate counts that cycle once.</p></section>
    <section className={`${panelClass} space-y-3`} aria-label="Branch progression"><h3 className="text-xl font-semibold">Branch progression</h3>{report.branches.length ? <ul className="space-y-3">{report.branches.map((branch, index) => <li key={index} className="border-b border-base-300 pb-3 break-words"><strong>{stageName(branch.fromStageId)} → {stageName(branch.toStageId)}</strong><p>{reportLabel(branch.kind)} · <Ratio ratio={branch.progression} /></p><p className="text-sm">Denominator: {branch.denominatorBasis === "SOURCE_STAGE_REACHED" ? "journeys ever reaching the source stage" : "all cohort journeys"}. {branch.transitions} recorded transitions.{branch.branchId ? ` Branch ${branch.branchId}.` : ""}</p></li>)}</ul> : <p>No recorded moves in this cohort.</p>}<p className="text-sm">Manual moves are separate. Missing branch evidence remains unknown. These rows are not additive and do not estimate eligibility for a rule.</p></section>
    <section className="space-y-3" aria-label="Financial outcomes"><h3 className="text-xl font-semibold">Financial outcomes</h3><p>Pipeline value: unavailable. Opportunity values and forecasts are not recorded by this funnel.</p><p className="text-sm">Distinct facts for selected subjects, from {reportUtc(report.money.factWindow.from)} through {reportUtc(report.money.factWindow.to)}, including both ends. Repeat cycles do not duplicate a subject’s facts.</p>
      {report.money.currencies.length ? <div className="grid gap-4 md:grid-cols-2">{report.money.currencies.map(currency => <section key={currency.currency} className={`${panelClass} space-y-4`} aria-label={`Money: ${currency.currency}`}><h4 className="font-semibold">{currency.currency}</h4><dl className="space-y-3"><div><dt>Gross paid</dt><dd><Money measure={currency.grossPaid} /></dd></div><div><dt>Successful refunds</dt><dd><Money measure={currency.successfulRefunds} /></dd></div><div><dt>Observed net cash</dt><dd className="font-semibold tabular-nums break-all">{currency.grossPaid.valuedFacts || currency.successfulRefunds.valuedFacts ? currency.netObservedCash : "Not valued"}</dd></div><div><dt>Recorded won-deal value</dt><dd><Money measure={currency.recordedWonValue} /></dd></div></dl><p className="text-sm">Paid evidence: {reportCounts(currency.grossPaid.authorityCounts)}. Refund evidence: {reportCounts(currency.successfulRefunds.authorityCounts)}. Won evidence: {reportCounts(currency.recordedWonValue.authorityCounts)}.</p></section>)}</div> : <p className={panelClass}>No valued financial evidence with a supported currency in this window.</p>}
      <p className="text-sm">{report.money.includedFacts} included facts · {report.money.unvaluedFacts} unvalued · {report.money.missingOrInvalidCurrencyFacts} missing or invalid currency · {report.money.excludedBeforeWindowFacts} before the financial window.</p><p className="text-sm">Currencies stay separate; amounts retain their exact decimal precision. Won-deal value is not cash received. Net cash can be negative when payment coverage is incomplete. Refunds preserve the original paid facts.</p>
    </section>
    <Coverage report={report} />
  </div>;
}

function CampaignResults({ report }: { report: FunnelReport }) {
  const a = report.attribution;
  return <div className="space-y-6">
    <section className="space-y-3" aria-label="Observed campaign references"><h3 className="text-xl font-semibold">Observed campaign references</h3><p className="text-sm">Retained matched subject history through the snapshot, including evidence before journey entry. Association does not establish causation or allocate revenue credit.</p>
      <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Tagged subjects" value={a.taggedSubjects} /><Metric label="Unknown attribution" value={a.unknownSubjects} note="No retained approved tags; not assumed organic" /><Metric label="Partial attribution" value={a.partialSubjects} note="No complete source, medium and campaign UTM tuple" /><Metric label="Multiple references" value={a.multiReferenceSubjects} note="No guessed first-touch or last-touch credit" /></dl>
      {a.references.length ? <ul className="grid md:grid-cols-2 gap-3">{a.references.map((reference, index) => <li key={index} className={`${panelClass} space-y-2 break-words`}><Link prefetch={false} className="underline font-semibold" href={`/tracking/${reference.sourceId}`}>{reference.sourceName}</Link><p className="text-sm">{reference.provider} · {reference.subjects} subjects · {reference.events} observations</p><dl className="space-y-1">{Object.entries(reference.values).map(([key, value]) => <div key={key}><dt className="text-sm">{key}</dt><dd className="break-all">{value}</dd></div>)}</dl><p className="text-sm">{reportCounts(reference.authorityCounts)}</p></li>)}</ul> : <p className={panelClass}>No retained campaign references for these subjects. Missing, blocked or erased tracking remains unknown.</p>}
      <p className="text-sm">Reference rows overlap and cannot be summed into unique subjects. Aggregate ad impressions, clicks and spend do not move an individual journey.</p>
    </section>
    <section className={`${panelClass} space-y-3`} aria-label="Configured campaign links"><h3 className="text-xl font-semibold">Configured campaign links</h3><p className="text-sm">This published configuration is separate from actual enrollment, consent and sending evidence.</p>{report.campaigns.configuredLinks.length ? <ul className="space-y-2">{report.campaigns.configuredLinks.map(link => <li key={link.linkId}>{report.stages.find(stage => stage.stageId === link.stageId)?.name ?? link.stageId} → <Link prefetch={false} className="underline" href={`/email/campaigns/${link.campaignId}`}>{link.campaignName}</Link> · attribution only</li>)}</ul> : <p>No campaign links configured in this version.</p>}</section>
    <section className="space-y-3" aria-label="Campaign execution"><h3 className="text-xl font-semibold">Campaign execution</h3><p>{report.campaigns.uniqueMemberships} unique memberships · {report.campaigns.uniqueAttributedSends} unique attributed sends</p><p className="text-sm">Explicit membership reasons and send attributions connect execution to these journeys. Actual pinned revisions are shown. Shared sends can appear in another cohort or version; reports are not additive.</p>
      {report.campaigns.results.length ? <div className="grid md:grid-cols-2 gap-3">{report.campaigns.results.map(result => <section key={result.revisionId} className={`${panelClass} space-y-3`} aria-label={`Campaign: ${result.campaignName}, revision ${result.revisionNumber}`}><h4 className="font-semibold"><Link prefetch={false} className="underline" href={`/email/campaigns/${result.campaignId}`}>{result.campaignName}</Link> · revision {result.revisionNumber}</h4><p>Membership scope: {reportLabel(result.membershipScope)}</p><p>{result.memberships.unique} memberships · {result.memberships.activeReasons} active reasons · {result.memberships.endedReasons} ended reasons</p><p className="text-sm">Membership states: {reportCounts(result.memberships.statusCounts)}</p><p>{result.sends.unique} attributed sends · {result.sends.attributionRows} attribution records</p><p className="text-sm">Send states: {reportCounts(result.sends.statusCounts)}</p><p className="text-sm">Delivery evidence: {reportCounts(result.sends.deliveryStateCounts)}</p><p className="text-sm">Shared across journeys: {result.sends.sharedAcrossJourneys} · Also attributed outside this cohort: {result.sends.sharedOutsideCohort}</p></section>)}</div> : <p className={panelClass}>No campaign execution associated with these journeys. Tracking-only funnels can report goals with zero email sends.</p>}
      <p className="text-sm">Provider acceptance is not confirmed delivery. Unknown outcomes remain unknown; report reads never enroll contacts or send messages.</p>
    </section>
  </div>;
}

function Coverage({ report }: { report: FunnelReport }) {
  const c = report.coverage;
  return <section className={`${panelClass} space-y-3`} aria-label="Evidence coverage"><h3 className="text-xl font-semibold">Evidence coverage</h3><p>These results use persisted evidence. They do not verify a live provider installation.</p><dl className="grid gap-3 sm:grid-cols-2"><div><dt>Manual changes</dt><dd>{c.manualTransitions} transitions in {report.totals.journeysWithManualChanges} journeys</dd></div><div><dt>History-mode transitions</dt><dd>{c.historyModeTransitions}</dd></div><div><dt>Redacted transition traces</dt><dd>{c.redactedTraceTransitions}</dd></div><div><dt>Missing entry history</dt><dd>{c.journeysWithMissingEntryHistory} journeys</dd></div><div><dt>Invalid or unknown durations</dt><dd>{c.invalidDurationIntervals} intervals</dd></div><div><dt>Unknown campaign attribution</dt><dd>{c.unknownCampaignSubjects} subjects</dd></div></dl><p className="text-sm">Ingestion evidence: {reportCounts(c.matchedEvidenceByIngestionMode)}.</p><p className="text-sm">Processing evidence: {reportCounts(c.matchedEvidenceByProcessingMode)}.</p><p className="text-sm">Financial provenance: {reportCounts(c.factProvenance)}.</p><p className="text-sm">Missing observations, retention, redaction and cross-device gaps limit coverage. Imports and history-only repairs do not imply live automation. Reports exceeding processing limits fail explicitly; totals are never silently truncated.</p></section>;
}
