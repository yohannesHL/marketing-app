"use client";
import Link from "next/link";
import { useEffect, useRef, type ReactNode } from "react";
import { Alert, Badge, Container, Stack, Typography } from "@launchpad/ui";
import { AccountNavigation } from "../connections/AccountNavigation";
import type { TrackingEnvironment } from "./trackingUi";
import { useAppNavigationEnvironment, useAppNavigationGuard } from "../navigation/AppShell";
export function TrackingLayout({ title, description, environment, loading, signedIn, busy, error, notice, children }: {
  title: string; description: string; environment: TrackingEnvironment; loading?: boolean; signedIn?: boolean; busy?: boolean;
  error?: string | null; notice?: string | null; children: ReactNode;
}) {
  const errorRef = useRef<HTMLDivElement>(null);
  useAppNavigationEnvironment(environment);
  useAppNavigationGuard(() => busy ? "Complete the current source setup and save any one-time credentials before leaving." : true);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  return <main className="py-8 sm:py-12" data-testid="tracking-page"><Container><Stack gap={6}>
    <AccountNavigation signedIn={signedIn ?? !loading} busy={busy} />
    <nav aria-label="Tracking navigation" className="flex flex-wrap gap-2">
      <Link className="btn btn-ghost min-h-11 normal-case" href={`/funnels?environment=${environment}`}>Funnels</Link>
      <Link className="btn btn-secondary min-h-11 normal-case" href={`/tracking?environment=${environment}`}>Tracking sources</Link>
    </nav>
    <header className="min-w-0"><Badge tone={environment === "LIVE" ? "warning" : "info"}>{environment}</Badge>
      <Typography as="h1" variant="heading-1" className="mt-3 break-words">{title}</Typography>
      <Typography className="mt-2 max-w-3xl" tone="muted">{description}</Typography></header>
    <Alert tone="info" role="note" title={environment === "TEST" ? "Test evidence" : "Live evidence"}>
      {environment === "TEST" ? "TEST sources are separate from LIVE. Recorded test evidence does not prove a live provider installation." : "LIVE requires deployment enablement and verified source setup. Receiving evidence does not grant marketing consent."}
    </Alert>
    {error && <div ref={errorRef} tabIndex={-1} className="rounded-box focus:outline focus:outline-2 focus:outline-primary"><Alert title="Tracking needs attention" tone="danger" role="alert">{error}</Alert></div>}
    {notice && <Alert title="Tracking update" tone="success" role="status">{notice}</Alert>}
    {loading ? <p role="status">Loading tracking sources…</p> : children}
    {busy && <p role="status" aria-live="polite">Source setup is in progress. Complete the current step before leaving.</p>}
  </Stack></Container></main>;
}
