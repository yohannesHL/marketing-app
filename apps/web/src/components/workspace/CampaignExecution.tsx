"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { connectionRequest, type Connection, type ProviderSettings, type SelectedAccountReadiness } from "../connections/connectionUi";
import type { CampaignType } from "../../server/workspace/types";
import styles from "./campaignBuilder.module.css";

export function CampaignExecution({ type, platforms, campaignId }: { type: CampaignType; platforms: string[]; campaignId?: string }) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [settings, setSettings] = useState<ProviderSettings | null>(null);
  const [readiness, setReadiness] = useState<SelectedAccountReadiness | null>(null);
  const [busy, setBusy] = useState(false); const [loaded, setLoaded] = useState(false); const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (type !== "ADS") return;
    let current = true;
    Promise.all([connectionRequest<Connection[]>("/api/connections"), connectionRequest<ProviderSettings>("/api/connections/providers")]).then(([data, providers]) => { if (current) { setConnections(data); setSettings(providers); setLoaded(true); } })
      .catch((failure) => { if (current) setError(failure instanceof Error ? failure.message : "Could not load connected accounts."); });
    return () => { current = false; };
  }, [type]);
  if (type === "SOCIAL") return <div className={styles.note}><h3>Next: prepare posts for approval</h3><p>Create posts from this campaign, add the finished media and review each destination. Approved, scheduled posts are delivered automatically. You can pause queued deliveries from each post.</p>{campaignId && <div className="mt-3"><Link href={`/social/create?campaignId=${encodeURIComponent(campaignId)}`} className={styles.button}>Prepare social posts</Link></div>}</div>;
  if (type === "EMAIL" || type === "BLOG") return <div className={styles.note}><h3>{type === "EMAIL" ? "Email draft ready for review" : "Article draft ready for review"}</h3><p>Your content is saved in your campaign and Content Studio. {type === "EMAIL" ? "Email delivery is not connected yet. Copy your approved content to your email service when ready." : "Website publication is not connected yet. Copy your approved article to your publishing system when ready."}</p></div>;
  const accounts = connections.filter((connection) => connection.capability === "ADS" && platforms.includes(connection.provider) && connection.status === "CONNECTED" && connection.connectionMode.toLowerCase() === settings?.mode && settings.paid.some((provider) => provider.provider === connection.provider && provider.enabled))
    .flatMap((connection) => connection.destinations.filter((destination) => destination.selected && destination.available && destination.metadata?.manager !== true).map((destination) => ({ connection, destination })));
  const missing = platforms.filter((platform) => !accounts.some((account) => account.connection.provider === platform));
  async function checkAccounts() {
    setBusy(true); setError(null); setReadiness(null);
    try { setReadiness(await connectionRequest<SelectedAccountReadiness>("/api/ads/readiness", "POST", { destinationIds: accounts.map((account) => account.destination.id) })); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Account readiness could not be checked."); }
    finally { setBusy(false); }
  }
  return <div className={styles.note}><h3>Advertising account readiness</h3><p>Google and Meta account checks use the configured provider APIs. Campaign creation and ad spending are currently disabled; this campaign stays a saved plan.</p>
    {loaded && <p>{accounts.length ? `${accounts.length} selected account${accounts.length === 1 ? "" : "s"} available for checking.` : "Select advertising accounts in Integrations / Channels."} {missing.length > 0 ? `Missing a selected account for ${missing.map((platform) => platform === "GOOGLE" ? "Google Ads" : "Meta Ads").join(" and ")}.` : ""}</p>}
    {error && <div className={styles.error} role="alert">{error}</div>}
    <div className={`${styles.actions} mt-3`}><button type="button" className={styles.secondary} disabled={busy || !accounts.length || accounts.length > 25} onClick={() => void checkAccounts()}>{busy ? "Checking accounts…" : "Check connected ad accounts"}</button><Link className={styles.textLink} href="/connections">Manage channels</Link></div>
    {readiness && <div role="status" className="mt-4"><p>{readiness.mode === "mock" ? "Mockoon check" : "Provider check"}: {readiness.success ? "selected accounts can be read." : "some accounts need attention."}</p><ul className="mt-2 grid gap-1">{readiness.outcomes.map((outcome) => <li key={outcome.destinationId}>{outcome.account?.name || (outcome.provider === "GOOGLE" ? "Google Ads" : "Meta Ads")} — {outcome.canRead ? "Read access verified" : "Check connection permissions"}</li>)}</ul><p>No campaign was created and no ad spend was authorized.</p></div>}
  </div>;
}
