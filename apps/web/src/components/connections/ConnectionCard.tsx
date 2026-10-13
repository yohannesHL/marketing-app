"use client";

import { useEffect, useRef, useState } from "react";
import { Badge, Button, Card, Select, Stack, Typography } from "@launchpad/ui";
import { checkedAt, providerLabel, statusLabel, type Connection, type Destination, type ProviderMode } from "./connectionUi";

export type ConnectionAction = "reconnect" | "refresh" | "check" | "select" | "deselect" | "disconnect";
export type OnConnectionAction = (connection: Connection, action: ConnectionAction, destination?: Destination, loginCustomerId?: string | null) => Promise<void>;

function DestinationRow({ destination, connection, busy, actionsEnabled, paid, onAction }: {
  destination: Destination; connection: Connection; busy: boolean; actionsEnabled: boolean; paid: boolean; onAction: OnConnectionAction;
}) {
  const contextValue = destination.selected && destination.selectedContext && "loginCustomerId" in destination.selectedContext
    ? destination.selectedContext.loginCustomerId ?? "direct" : "";
  const [context, setContext] = useState<string>(contextValue);
  useEffect(() => { setContext(contextValue); }, [contextValue, destination.id]);
  const google = connection.provider === "GOOGLE";
  const metadata = destination.metadata;
  const manager = metadata?.manager === true;
  const canChoose = actionsEnabled && destination.available && !manager && metadata?.canWrite !== "DENIED";
  const contexts = metadata?.contexts ?? [];
  return <li className="rounded-box border border-base-300 p-4 sm:p-5" data-testid="connection-destination">
    <Stack gap={4}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0"><Typography as="h4" className="break-words font-semibold">{destination.name || "Unnamed account"}</Typography>
          <Typography tone="muted" className="break-all">{manager ? "Manager" : paid ? "Ad account" : destination.kind.replaceAll("_", " ").toLowerCase()} · {destination.externalId}</Typography></div>
        <Badge tone={destination.selected ? "success" : "neutral"} className="h-auto min-h-6 py-1">{destination.selected ? "Selected" : "Not selected"}</Badge>
      </div>
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {paid ? <><div><dt className="font-semibold">Currency</dt><dd>{destination.currency || "Not provided"}</dd></div>
          <div><dt className="font-semibold">Timezone</dt><dd className="break-words">{destination.timezone || "Not provided"}</dd></div></> : null}
        <div><dt className="font-semibold">Last checked</dt><dd>{checkedAt(destination.lastCheckedAt)}</dd></div>
        <div><dt className="font-semibold">Read access</dt><dd>{metadata?.canRead === true ? "Verified" : metadata?.canRead === false ? "Denied" : "Not verified"}</dd></div>
        <div><dt className="font-semibold">{paid ? "Campaign management" : "Publishing permission"}</dt><dd>{metadata?.canWrite === "ALLOWED" ? "Allowed" : metadata?.canWrite === "DENIED" ? "Denied" : "Not verified"}</dd></div>
        <div><dt className="font-semibold">Availability</dt><dd>{manager ? "Manager only" : destination.available ? "Available" : "Unavailable"}</dd></div>
      </dl>
      {metadata?.tasks?.length ? <Typography tone="muted">Account tasks: {metadata.tasks.join(", ")}</Typography> : null}
      {google && paid && !manager ? <Select label="Google access path" aria-label={`Google access path for ${destination.name || destination.externalId}`}
        description="Choose direct access or a verified manager."
        placeholder="Choose an access path" value={context} disabled={busy || !canChoose} className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
        onChange={(event) => setContext(event.target.value)} options={contexts.map((item) => ({
          value: item.loginCustomerId ?? "direct", label: item.loginCustomerId ? `Via manager ${item.loginCustomerId}` : "Direct access",
        }))} /> : null}
      {destination.selectedContext && google && paid && destination.selected ? <Typography tone="muted">Selected access: {destination.selectedContext.loginCustomerId ? `manager ${destination.selectedContext.loginCustomerId}` : "direct"}</Typography> : null}
      {manager ? <Typography tone="muted">Select a child advertising account to use this manager’s access.</Typography>
        : paid || actionsEnabled ? <div className="flex flex-wrap gap-3">
          <Button variant="secondary" className="min-h-11" disabled={busy || !actionsEnabled || !destination.available} onClick={() => onAction(connection, "check", destination)}>Check read access</Button>
          {destination.selected ? <><Button variant="secondary" className="min-h-11" disabled={busy} onClick={() => onAction(connection, "deselect", destination)}>Deselect account</Button>
            {google && context !== contextValue ? <Button className="min-h-11" disabled={busy || !canChoose || !context || !contexts.some((item) => (item.loginCustomerId ?? "direct") === context)} onClick={() => onAction(connection, "select", destination, context === "direct" ? null : context)}>Save access path</Button> : null}</>
            : <Button className="min-h-11" disabled={busy || !canChoose || (google && paid && (!context || !contexts.some((item) => (item.loginCustomerId ?? "direct") === context)))}
              onClick={() => onAction(connection, "select", destination, context === "direct" ? null : context)}>Select account</Button>}
        </div> : <Typography tone="muted">Publishing controls become available when this platform’s publishing integration is enabled.</Typography>}
      {!destination.available && !manager ? <Typography tone="muted">Refresh discovery or reconnect to check whether this account is available again.</Typography> : null}
    </Stack>
  </li>;
}

export function ConnectionCard({ connection, mode, enabled, busy, paid, onAction }: {
  connection: Connection; mode: ProviderMode; enabled: boolean; busy: boolean; paid: boolean; onAction: OnConnectionAction;
}) {
  const [confirm, setConfirm] = useState(false);
  const label = paid ? providerLabel(connection.provider) : connection.provider === "META" ? "Meta social publishing" : connection.provider === "GOOGLE" ? "YouTube publishing" : providerLabel(connection.provider);
  const confirmRef = useRef<HTMLDivElement>(null);
  const disconnectRef = useRef<HTMLButtonElement>(null);
  const modeMatches = connection.connectionMode.toLowerCase() === mode;
  const usable = enabled && modeMatches && connection.status === "CONNECTED";
  useEffect(() => { if (confirm) confirmRef.current?.focus(); }, [confirm]);
  return <Card data-testid="provider-connection" aria-busy={busy}>
    <div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0">
      <Typography as="h3" variant="heading-3">{label}</Typography>
      <Typography tone="muted" className="break-all">Identity {connection.providerUserId}</Typography>
    </div><div className="flex flex-wrap gap-2"><Badge tone={connection.status === "CONNECTED" ? "success" : "warning"} className="h-auto min-h-6 py-1">{statusLabel(connection.status)}</Badge>
      <Badge className="h-auto min-h-6 py-1">{connection.connectionMode === "MOCK" ? "Mockoon test connection" : connection.connectionMode === "LIVE" ? "Live connection" : "Legacy connection"}</Badge></div></div>
    {connection.status !== "CONNECTED" ? <Typography tone="muted">{connection.status === "DISCONNECTED" ? "Access has been removed. Reconnect to discover accounts again." : "Approve access again before using accounts from this connection."}</Typography> : null}
    {!modeMatches ? <Typography tone="muted">This connection belongs to a different environment and cannot be used in the current mode.</Typography> : null}
    {enabled || paid ? <div className="flex flex-wrap gap-3">
      <Button variant="secondary" className="min-h-11" disabled={busy || !enabled || !modeMatches} onClick={() => onAction(connection, "reconnect")}>Reconnect {label}</Button>
      <Button variant="secondary" className="min-h-11" disabled={busy || !usable} onClick={() => onAction(connection, "refresh")}>Refresh accounts</Button>
    </div> : null}
    {connection.destinations.length ? <ul className="grid gap-4" aria-label={`${label} ${paid ? "advertising accounts" : "publishing destinations"}`}>
      {connection.destinations.map((destination) => <DestinationRow key={destination.id} destination={destination} connection={connection} paid={paid} busy={busy} actionsEnabled={usable} onAction={onAction} />)}
    </ul> : <Typography tone="muted">{paid ? "No advertising accounts were discovered. Check permissions, then refresh accounts." : "No publishing destinations have been discovered for this permission grant."}</Typography>}
    {connection.status !== "DISCONNECTED" ? confirm ? <div ref={confirmRef} tabIndex={-1} className="rounded-box border border-warning p-4 focus:outline focus:outline-2 focus:outline-primary">
      <Stack gap={3}><Typography className="font-semibold">Disconnect {label}?</Typography>
        <Typography>Disconnecting removes this app’s access, deselects its destinations, and stops queued work. Work already published at the provider remains there.</Typography>
        <div className="flex flex-wrap gap-3"><Button variant="destructive" disabled={busy} className="min-h-11" onClick={() => onAction(connection, "disconnect")}>Confirm disconnect</Button>
          <Button variant="secondary" disabled={busy} className="min-h-11" onClick={() => { setConfirm(false); requestAnimationFrame(() => disconnectRef.current?.focus()); }}>Keep connection</Button></div>
      </Stack></div> : <div><Button ref={disconnectRef} variant="ghost" className="min-h-11" disabled={busy} onClick={() => setConfirm(true)}>Disconnect {label}</Button></div> : null}
  </Card>;
}
