"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, Card, Container, Stack, Typography } from "@launchpad/ui";
import { AccountNavigation } from "./AccountNavigation";
import { ConnectionCard, type OnConnectionAction } from "./ConnectionCard";
import { authorizationTarget, connectionEndpoint, connectionRequest, ConnectionUiError, errorHelp, providerLabel, socialPlatform,
  type Connection, type Provider, type SocialProvider, type ProviderSettings, type SelectedAccountReadiness } from "./connectionUi";

const SOCIAL_PLATFORMS = [
  { provider: "FACEBOOK", label: "Facebook Pages" }, { provider: "INSTAGRAM", label: "Instagram" },
  { provider: "YOUTUBE", label: "YouTube Shorts" }, { provider: "TIKTOK", label: "TikTok" },
  { provider: "LINKEDIN", label: "LinkedIn" }, { provider: "X", label: "X" },
];

export function ConnectionsPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [settings, setSettings] = useState<ProviderSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [signedIn, setSignedIn] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<SelectedAccountReadiness | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const epoch = useRef(0);
  const actionPending = useRef(false);

  const load = useCallback(async () => {
    const current = ++epoch.current;
    try {
      const [rows, configuration] = await Promise.all([
        connectionRequest<Connection[]>("/api/connections"),
        connectionRequest<ProviderSettings>("/api/connections/providers"),
      ]);
      if (epoch.current !== current) return;
      setConnections(rows); setSettings(configuration); setSignedIn(true);
    } catch (failure) {
      if (epoch.current !== current) return;
      if (failure instanceof ConnectionUiError && failure.status === 401) {
        setSignedIn(false); setConnections([]); setSettings(null);
        window.location.replace("/sign-in?returnTo=%2Fconnections");
      } else throw failure;
    } finally { if (epoch.current === current) setLoading(false); }
  }, []);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const provider = params.get("provider");
    const label = ({ google: "Google Ads", meta: "Meta Ads", youtube: "YouTube Shorts", "meta-publishing": "Meta social publishing", tiktok: "TikTok", linkedin: "LinkedIn", x: "X" } as Record<string, string>)[provider ?? ""] ?? "Provider";
    if (params.get("result") === "connected") setNotice(`${label} connected. Review the discovered accounts and select the ones you want to use.`);
    if (params.get("result") === "failed" || params.has("error")) setError(errorHelp(params.get("error") ?? undefined));
    load().catch((failure) => setError(failure instanceof ConnectionUiError ? failure.message : errorHelp()));
    return () => { epoch.current += 1; };
  }, [load]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);

  async function run(key: string, action: () => Promise<void>) {
    if (actionPending.current) return;
    actionPending.current = true;
    setBusy(key); setError(null); setNotice(null); setReadiness(null);
    try { await action(); }
    catch (failure) {
      if (failure instanceof ConnectionUiError && failure.status === 401) {
        setConnections([]); setSettings(null); setSignedIn(false);
        window.location.replace("/sign-in?returnTo=%2Fconnections");
      } else {
        setError(failure instanceof ConnectionUiError ? failure.message : errorHelp());
        // Re-read after provider errors: revoked or expired access can change state.
        await load().catch(() => {});
      }
    } finally { actionPending.current = false; setBusy(null); }
  }
  async function start(provider: Provider | SocialProvider, authorizationId?: string) {
    await run(authorizationId ?? provider, async () => {
      const result = await connectionRequest<{ authorizationUrl: string; mode: ProviderSettings["mode"] }>(
        `/api/connections/${provider === "FACEBOOK" || provider === "INSTAGRAM" ? "meta-publishing" : provider.toLowerCase()}/start`, "POST", authorizationId ? { authorizationId } : {});
      if (!settings || settings.mode !== result.mode) throw new ConnectionUiError("CONNECTION_MODE_MISMATCH", 409);
      window.location.assign(authorizationTarget(result.authorizationUrl, provider, result.mode));
    });
  }
  const onAction: OnConnectionAction = async (connection, action, destination, loginCustomerId) => {
    if (action === "reconnect") {
      const provider = connection.capability === "SOCIAL" ? socialPlatform(connection.provider) : connection.provider as Provider;
      if (provider) await start(provider, connection.id);
      return;
    }
    await run(connection.id, async () => {
      const endpoint = connectionEndpoint(connection.provider, connection.capability);
      if (!endpoint) throw new ConnectionUiError("PROVIDER_DISABLED", 503);
      const base = `/api/connections/${endpoint}/${encodeURIComponent(connection.id)}`;
      if (action === "disconnect") await connectionRequest(`/api/connections/${encodeURIComponent(connection.id)}`, "DELETE");
      else if (action === "deselect" && destination) await connectionRequest(`/api/connections/destinations/${encodeURIComponent(destination.id)}`, "PATCH", { selected: false });
      else if (action === "refresh") await connectionRequest(`${base}/refresh`, "POST", {});
      else if (action === "check" && destination) await connectionRequest(`${base}/check`, "POST", { destinationId: destination.id });
      else if (action === "select" && destination) await connectionRequest(`${base}/select`, "POST", {
        destinationId: destination.id, ...(connection.provider === "GOOGLE" && connection.capability === "ADS" ? { loginCustomerId: loginCustomerId ?? null } : {}),
      });
      await load();
      setNotice(({ disconnect: "Connection removed. Its accounts are deselected and queued work is stopped.",
        deselect: "Destination deselected. Queued work for it is stopped.",
        refresh: "Accounts refreshed. Review their current availability and permissions.",
        check: "Read access checked. This check does not publish or spend money.",
        select: connection.capability === "SOCIAL" ? "Publishing destination selected. Review and approve content before scheduling a post." : "Account selected for campaign planning.", reconnect: "" })[action]);
    });
  };
  const paid = connections.filter((connection) => connection.capability === "ADS");
  const social = connections.filter((connection) => connection.capability === "SOCIAL");
  const selectedAccounts = paid.flatMap((connection) => connection.destinations.filter((destination) => destination.selected)
    .map((destination) => ({ connection, destination })));
  const selectedReady = selectedAccounts.length > 0 && selectedAccounts.length <= 25 && selectedAccounts.every(({ connection, destination }) =>
    connection.status === "CONNECTED" && connection.connectionMode.toLowerCase() === settings?.mode &&
    (connection.provider === "GOOGLE" || connection.provider === "META") &&
    settings?.paid.some((provider) => provider.provider === connection.provider && provider.enabled) && destination.available && destination.metadata?.manager !== true);
  async function checkSelected() {
    if (!selectedReady) return;
    await run("selected-readiness", async () => {
      const result = await connectionRequest<SelectedAccountReadiness>("/api/ads/readiness", "POST", {
        destinationIds: selectedAccounts.map(({ destination }) => destination.id),
      });
      await load(); setReadiness(result);
    });
  }

  return <main className="py-8 sm:py-12" data-testid="connections-page"><Container><Stack gap={8}>
    <AccountNavigation signedIn={signedIn} busy={Boolean(busy)} onError={(failure) => setError(failure instanceof ConnectionUiError ? failure.message : errorHelp())} />
    <div><Typography as="span" variant="overline">Workspace access</Typography>
      <Typography as="h1" variant="heading-1">Connections</Typography>
      <Typography tone="muted" className="max-w-3xl">Connect provider identities, review permissions, and choose accounts for your campaigns. Advertising and social publishing each need their own authorization.</Typography></div>
    {error ? <div ref={errorRef} tabIndex={-1} className="rounded-box focus:outline focus:outline-2 focus:outline-primary"><Alert title="Connection needs attention" tone="danger">{error}</Alert></div> : null}
    {busy ? <div role="status" aria-live="polite" className="font-medium">Updating connection… Please wait.</div> : null}
    {notice ? <Alert title="Connection update" tone="success" role="status">{notice}</Alert> : null}
    {settings ? <Alert tone={settings.mode === "mock" ? "warning" : "info"} title={settings.mode === "mock" ? "Mockoon test mode" : settings.mode === "live" ? "Live provider mode" : "Provider connections disabled"} role="note">
      {settings.mode === "mock" ? "Connections and checks use local test providers. No live accounts are authorized, no real ads are launched, and no money is spent."
        : settings.mode === "live" ? "Connections authorize real provider accounts. Read checks do not create campaigns. Live launch availability is shown for each provider."
        : "Provider setup is needed before you can connect an account. Contact your workspace administrator."}
    </Alert> : null}
    {loading ? <div role="status" aria-live="polite" className="rounded-box border border-base-300 p-6">Loading your connections…</div>
      : error && !settings ? <Card><Typography>Connections could not be loaded.</Typography><Button disabled={Boolean(busy)} onClick={() => run("reload", async () => { setLoading(true); await load(); })}>Try loading again</Button></Card>
      : !signedIn ? <Card><Typography>Sign in to see your workspace connections.</Typography><Link className="btn btn-primary normal-case" href="/sign-in?returnTo=%2Fconnections">Sign in</Link></Card>
      : <>
        <section aria-labelledby="paid-connections-heading" data-testid="paid-connections"><Stack gap={5}>
          <div><Typography as="h2" id="paid-connections-heading" variant="heading-2">Paid advertising</Typography>
            <Typography tone="muted">Choose Google Ads or Meta advertising accounts. Selection alone does not authorize spending or confirm write access.</Typography></div>
          <div className="grid gap-4 md:grid-cols-2">{(["GOOGLE", "META"] as const).map((provider) => {
            const config = settings?.paid.find((item) => item.provider === provider);
            return <Card key={provider}><Typography as="h3" variant="heading-3">{providerLabel(provider)}</Typography>
              <Typography tone="muted">{provider === "GOOGLE" ? "Discover advertising accounts and their manager access paths." : "Discover advertising accounts and your campaign management permissions."}</Typography>
              <div><Badge tone={config?.liveWritesEnabled ? "success" : "neutral"} className="h-auto py-1">{settings?.mode === "mock" ? "Test accounts only" : config?.liveWritesEnabled ? "Live launch enabled" : "Live launch disabled"}</Badge></div>
              {!config?.enabled ? <Typography tone="muted">Connection setup is unavailable in this environment.</Typography> : null}
              <Button className="min-h-11" disabled={Boolean(busy) || !config?.enabled || settings?.mode === "disabled"} loading={busy === provider} onClick={() => start(provider)}>Connect {providerLabel(provider)}</Button>
            </Card>;
          })}</div>
          <div className="rounded-box border border-base-300 p-4"><Stack gap={3}>
            <Typography className="font-semibold">Check your selected accounts</Typography>
            <Typography tone="muted">Read readiness is checked only for your selected advertising accounts. It does not create campaigns or enable live spending.</Typography>
            <div><Button variant="secondary" className="min-h-11" loading={busy === "selected-readiness"} disabled={Boolean(busy) || !selectedReady}
              onClick={checkSelected}>Check selected accounts</Button></div>
            {!selectedAccounts.length ? <Typography tone="muted">Select an advertising account to check readiness.</Typography> : !selectedReady ? <Typography tone="muted">Your selected accounts must be available, connected, and in the current provider mode. Check up to 25 accounts at once.</Typography> : null}
            {readiness ? <div role="status" aria-live="polite" data-testid="selected-account-readiness"><Stack gap={3}>
              <Typography className="font-semibold">{readiness.success ? "Selected accounts can be read." : readiness.partial ? "Some selected accounts need attention." : "Selected accounts need attention."}</Typography>
              <Typography>Live campaign writes remain disabled.</Typography>
              <ul className="grid gap-3">{readiness.outcomes.map((outcome) => {
                const destination = paid.flatMap((connection) => connection.destinations).find((item) => item.id === outcome.destinationId);
                return <li key={outcome.destinationId} className="break-words">
                  <Typography className="font-semibold">{providerLabel(outcome.provider)} · {destination?.name || outcome.account?.name || "Advertising account"}</Typography>
                  <Typography>{outcome.success && outcome.canRead ? "Read access verified." : errorHelp(outcome.error?.code)}</Typography>
                </li>;
              })}</ul>
            </Stack></div> : null}
          </Stack></div>
          {!paid.length ? <Typography tone="muted">No advertising permissions connected yet. Connect a provider to discover your accounts.</Typography> : null}
          {paid.map((connection) => <ConnectionCard key={connection.id} connection={connection} mode={settings?.mode ?? "disabled"}
            enabled={settings?.paid.some((item) => item.provider === connection.provider && item.enabled) ?? false}
            paid busy={Boolean(busy)} onAction={onAction} />)}
        </Stack></section>
        <section aria-labelledby="social-connections-heading" data-testid="social-connections"><Stack gap={5}>
          <div><Typography as="h2" id="social-connections-heading" variant="heading-2">Social publishing</Typography>
            <Typography tone="muted">Publishing permissions are separate from advertising. A Google Ads or Meta Ads connection does not authorize social posts. Meta supports Facebook Pages with content creation access and linked Instagram professional accounts; personal profiles are not eligible.</Typography></div>
          {social.map((connection) => <ConnectionCard key={connection.id} connection={connection} mode={settings?.mode ?? "disabled"}
            enabled={settings?.social.some((item) => item.provider === socialPlatform(connection.provider) && item.enabled) ?? false} paid={false} busy={Boolean(busy)} onAction={onAction} />)}
          {!social.length ? <Typography tone="muted">No social publishing permissions connected yet.</Typography> : null}
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Social publishing platforms">{SOCIAL_PLATFORMS.map((platform) => {
            const config = settings?.social.find((item) => item.provider === platform.provider);
            return <li key={platform.provider} className="rounded-box border border-base-300 p-4"><Stack gap={3}>
              <Typography className="font-semibold">{platform.label}</Typography>
              <Typography tone="muted" variant="caption">{config?.enabled ? "Connect and choose a verified publishing destination. Selection does not publish content." : "Publishing connection setup is unavailable in this environment."}</Typography>
              {config?.enabled ? <Button className="min-h-11" disabled={Boolean(busy)} loading={busy === platform.provider}
                onClick={() => start(platform.provider as SocialProvider)}>Connect {platform.label}</Button> : null}
            </Stack></li>;
          })}</ul>
        </Stack></section>
      </>}
    <Typography tone="muted" variant="caption">Credentials stay on the server. Disconnect a provider to remove this app’s access and stop queued work.</Typography>
  </Stack></Container></main>;
}
