"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Alert, Button } from "@launchpad/ui";
import { TrackingBadge as Badge } from "./TrackingBadge";
import { dateLabel, EVENT_STATUS, identityHelp, PROVIDER_LABELS, sourceLink, trackingError, trackingRequest,
  type SourceSummary, type TrackingEnvironment } from "./trackingUi";

export function SourceEvidence({ source }: { source: SourceSummary }) {
  const receipt = source.health.lastReceipt;
  return <div className="min-w-0 space-y-4">
    <div className="flex flex-wrap gap-2"><Badge tone={source.status === "ACTIVE" ? "success" : "warning"}>{source.status === "ACTIVE" ? "Configured" : source.status === "PAUSED" ? "Paused" : "Disconnected"}</Badge><Badge>{source.environment}</Badge><Badge>{PROVIDER_LABELS[source.provider]}</Badge></div>
    <p>{source.health.explanation}</p>
    <dl className="grid min-w-0 gap-3 sm:grid-cols-2"><div><dt className="text-sm">Last received</dt><dd className="font-medium">{dateLabel(receipt?.receivedAt)}</dd></div><div><dt className="text-sm">Matched evidence</dt><dd className="font-medium">{source.health.matchedEvents} event{source.health.matchedEvents === 1 ? "" : "s"}</dd></div><div><dt className="text-sm">Needs review</dt><dd>{source.health.unresolvedEvents}</dd></div><div><dt className="text-sm">Conflicting deliveries</dt><dd>{source.health.conflictingEvents}</dd></div></dl>
    {receipt ? <div className="min-w-0 rounded-box border border-base-300 p-3 space-y-2"><p className="font-medium break-all">Latest source event: {receipt.type}</p><p>{EVENT_STATUS[receipt.status] ?? receipt.status}{receipt.reason ? ` · ${receipt.reason}` : ""}</p><p className="break-all text-sm">{receipt.subjectId ? `Matched subject: ${receipt.subjectId}` : "No matched business subject on this receipt."}</p><Link href={`${sourceLink(source)}&event=${encodeURIComponent(receipt.id)}#event-inbox`} className="link inline-flex min-h-11 items-center">Inspect this event</Link></div> : <p>No events have arrived yet. An idle source is not necessarily broken; complete setup and inspect an actual submission.</p>}
    <p className="text-sm">Received and matched counts describe stored evidence. Automation also needs a published rule, explicit action controls, campaign readiness and recipient consent.</p>
    <details><summary className="cursor-pointer min-h-11 py-2 font-medium">Event and identity configuration</summary><div className="space-y-3 pt-2"><p>{identityHelp(source.provider)}</p><p className="break-all"><strong>Events:</strong> {source.config.allowedEvents.join(", ") || "None configured"}</p><p className="break-all"><strong>Properties:</strong> {source.config.propertyKeys.join(", ") || "None configured"}</p></div></details>
  </div>;
}
export function SourceInspector({ sourceId, environment }: { sourceId?: string | null; environment: TrackingEnvironment }) {
  const [source, setSource] = useState<SourceSummary | null>(null), [error, setError] = useState<string | null>(null), [loading, setLoading] = useState(false), [revision, setRevision] = useState(0);
  const epoch = useRef(0);
  useEffect(() => {
    const current = ++epoch.current; setSource(null); setError(null);
    if (!sourceId) { setLoading(false); return; }
    setLoading(true);
    trackingRequest<SourceSummary>(`/api/tracking/sources/${encodeURIComponent(sourceId)}?environment=${environment}`)
      .then(value => { if (epoch.current === current) { if (value.environment !== environment) throw new Error("Environment changed"); setSource(value); } })
      .catch(failure => { if (epoch.current === current) setError(trackingError(failure)); })
      .finally(() => { if (epoch.current === current) setLoading(false); });
    return () => { epoch.current++; };
  }, [sourceId, environment, revision]);
  return <section aria-label="Source diagnostics" className="min-w-0 rounded-box border border-base-300 bg-base-100 p-4 space-y-4" data-testid="source-inspector">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-lg font-semibold break-words">{source?.name ?? "Tracking source"}</h3>{sourceId && <Button variant="ghost" className="min-h-11" disabled={loading} onClick={() => setRevision(value => value + 1)}>Refresh source</Button>}</div>
    {!sourceId ? <p>Choose a source for this rule to inspect its event and identity evidence. <Link href={`/tracking?environment=${environment}`} className="link">Set up a source</Link>.</p> : loading ? <p role="status">Loading source evidence…</p> : error ? <Alert tone="warning" title="Source unavailable" role="alert">{error}</Alert> : source ? <><SourceEvidence source={source} /><Link href={sourceLink(source)} className="btn btn-secondary min-h-11 h-auto py-2 normal-case">Open source settings and inbox</Link></> : null}
  </section>;
}
