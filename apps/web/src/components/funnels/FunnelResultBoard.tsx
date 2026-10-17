"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { FunnelReport, FunnelJourneySubjectSummary } from "../../server/funnels/funnelReportingTypes";
import { buttonClass, funnelRequest, message, panelClass, type UiJourney } from "./funnelUi";
import { reportLabel, reportUtc } from "./reportDisplay";

type BoardJourney = UiJourney & { subject: FunnelJourneySubjectSummary };
type BoardPage = { journeys: BoardJourney[]; total: number; nextCursor: string | null };

export function FunnelResultBoard({ report }: { report: FunnelReport }) {
  const [rows, setRows] = useState<BoardJourney[]>([]), [total, setTotal] = useState<number | null>(null);
  const [cursor, setCursor] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [moreBusy, setMoreBusy] = useState(false), [refresh, setRefresh] = useState(0);
  const [loadedAt, setLoadedAt] = useState<string | null>(null), generation = useRef(0);
  const query = new URLSearchParams({ versionId: report.version.id, from: report.cohort.from, to: report.cohort.to }).toString();
  const endpoint = `/api/funnels/${report.funnel.id}/journeys?${query}`;
  useEffect(() => {
    const token = ++generation.current; setLoading(true); setMoreBusy(false); setError(null); setRows([]); setTotal(null); setCursor(null); setLoadedAt(null);
    funnelRequest<BoardPage>(endpoint).then(page => {
      if (token === generation.current) { setRows(page.journeys); setTotal(page.total); setCursor(page.nextCursor); setLoadedAt(new Date().toISOString()); }
    }).catch(e => { if (token === generation.current) setError(message(e)); }).finally(() => { if (token === generation.current) setLoading(false); });
    return () => { generation.current++; };
  }, [endpoint, refresh]);
  async function more() {
    if (!cursor || moreBusy) return;
    const token = generation.current; setMoreBusy(true); setError(null);
    try {
      const page = await funnelRequest<BoardPage>(`${endpoint}&cursor=${encodeURIComponent(cursor)}`);
      if (token !== generation.current) return;
      setRows(old => [...old, ...page.journeys.filter(row => !old.some(previous => previous.id === row.id))]);
      setTotal(page.total); setCursor(page.nextCursor); setLoadedAt(new Date().toISOString());
    } catch (e) { if (token === generation.current) setError(message(e)); }
    finally { if (token === generation.current) setMoreBusy(false); }
  }
  return <section className="space-y-4" aria-label="Stage board">
    <div className="flex flex-wrap gap-3 items-center justify-between"><h3 className="text-xl font-semibold">Stage board</h3>
      <button className={buttonClass} disabled={loading || moreBusy} onClick={() => setRefresh(value => value + 1)}>Refresh board</button></div>
    <p className="text-sm">Independent {report.funnel.subjectKind === "SALES" ? "sales enquiries" : report.funnel.subjectKind === "PURCHASE" ? "purchase journeys" : "people"} and their cycles. Open a card to inspect evidence or record a correction with a reason.</p>
    <p className="text-sm">Cards show current operational state and load in pages. They can change after the report snapshot at {reportUtc(report.cohort.asOf)}. Stage totals below belong to that report snapshot.</p>
    {loadedAt && <p className="text-sm" role="status">Loaded {rows.length} of {total} matching journeys · Last card fetch {reportUtc(loadedAt)}.</p>}
    {error && <p role="alert" className="border border-error rounded-box p-3">{error}</p>}
    {loading ? <p role="status">Loading stage board…</p> : total === 0 ? <p className={panelClass}>No journeys match this version and entry window.</p> : <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {report.stages.map(stage => {
        const cards = rows.filter(row => row.currentStageKey === stage.stageId);
        return <section key={stage.stageId} aria-label={`Board stage: ${stage.name}`} className={`${panelClass} space-y-3 bg-base-200/30`}>
          <header><h4 className="font-semibold break-words">{stage.name}</h4><p className="text-sm">{stage.currentJourneys} current in report · {cards.length} cards loaded here</p></header>
          {cards.length ? <ul className="space-y-3">{cards.map(row => <li key={row.id} className="rounded-box bg-base-100 border border-base-300 p-3 space-y-2 break-words">
            <p className="font-semibold">{row.subject.contact?.name || row.subject.contact?.email || "Contact unavailable"}</p>
            {row.subject.contact?.name && row.subject.contact.email && <p className="text-sm break-all">{row.subject.contact.email}</p>}
            <p className="text-xs break-all">Subject {row.subjectId} · Cycle {row.cycle}</p>
            <p className="text-sm">{reportLabel(row.status)} · Entered {reportUtc(row.startedAt)}</p>
            <Link prefetch={false} className="btn btn-ghost min-h-11 normal-case h-auto whitespace-normal text-left" href={`/funnels/${report.funnel.id}/journeys/${row.id}`}>Inspect journey {row.cycle}</Link>
          </li>)}</ul> : <p className="text-sm">No loaded cards in this stage.</p>}
        </section>;
      })}
    </div>}
    {cursor && <button className={buttonClass} disabled={loading || moreBusy} onClick={more}>{moreBusy ? "Loading more…" : "Load more board journeys"}</button>}
    <p className="text-sm">Pipeline value, sales notes, follow-up tasks and forecasting are not available in this board.</p>
  </section>;
}
