"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";
import type { Environment } from "./funnelUi";
import { useAppNavigationEnvironment, useAppNavigationGuard } from "../workspace/AppShell";
import "./funnel-workspace.css";

export function FunnelLayout({ title, description, environment, headerActions, headerMeta, children, loading, busy, error, notice, onError, dirty = false }: {
  title: string; description?: string; environment?: Environment; children: ReactNode; loading?: boolean; busy?: boolean;
  headerActions?: ReactNode; headerMeta?: ReactNode;
  error?: string | null; notice?: string | null; onError?: (error: unknown) => void; dirty?: boolean;
}) {
  const errorRef = useRef<HTMLDivElement>(null), pathname = usePathname();
  useAppNavigationEnvironment(environment);
  useAppNavigationGuard(() => busy ? "Wait for the current funnel update to finish before leaving." : !dirty || window.confirm("Leave this page and discard unsaved funnel edits?"));
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => { if (!dirty) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, [dirty]);
  return <section className="workspace-page funnel-workspace space-y-6">
    <nav aria-label="Funnel navigation" className="module-tabs">
      <Link prefetch={false} href={environment ? `/funnels?environment=${environment}` : "/funnels"}>All funnels</Link>
      <Link prefetch={false} href={environment ? `/tracking?environment=${environment}` : "/tracking"}>Tracking sources</Link>
      <Link prefetch={false} href={environment ? `/email?environment=${environment}` : "/email"}>Email campaigns</Link>
    </nav>
    <header className="space-y-2 min-w-0"><div className="funnel-heading-row"><div className="funnel-heading-title"><h1 className="text-3xl font-semibold tracking-tight break-words min-w-0">{title}</h1>
      {!headerMeta && environment && <span className="badge badge-outline">{environment}</span>}</div>
      {headerActions && <div className="funnel-heading-actions">{headerActions}</div>}</div>
      {headerMeta && <div className="funnel-heading-meta">{environment && <span className="badge badge-outline">{environment}</span>}{headerMeta}</div>}
      {description && <p className="max-w-4xl text-base-content/75">{description}</p>}
      {!headerMeta && environment === "TEST" && <p className="text-sm">Test environment. Test evidence does not prove live provider setup or delivery.</p>}</header>
    {error && <div ref={errorRef} tabIndex={-1} role="alert" className="rounded-box border border-error p-4 break-words focus:outline focus:outline-2 focus:outline-error">{error}
      {error.includes("session ended") && <Link className="underline ml-2" target="_blank" href={`/sign-in?returnTo=${encodeURIComponent(pathname)}`}>Sign in in another tab</Link>}</div>}
    {notice && <p role="status" className="rounded-box border border-success p-3">{notice}</p>}
    <div id="funnel-content" className="min-w-0" aria-busy={busy || loading}>{loading ? <p role="status">Loading workspace…</p> : children}</div>
    {busy && <p role="status" aria-live="polite">Updating workspace…</p>}
  </section>;
}
