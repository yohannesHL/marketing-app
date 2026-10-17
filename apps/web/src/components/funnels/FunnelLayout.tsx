"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";
import { AccountNavigation } from "../connections/AccountNavigation";
import type { Environment } from "./funnelUi";
import { useAppNavigationEnvironment, useAppNavigationGuard } from "../navigation/AppShell";
import "./funnel-workspace.css";

export function FunnelLayout({ title, description, environment, children, loading, busy, error, notice, onError, dirty = false }: {
  title: string; description?: string; environment?: Environment; children: ReactNode; loading?: boolean; busy?: boolean;
  error?: string | null; notice?: string | null; onError?: (error: unknown) => void; dirty?: boolean;
}) {
  const errorRef = useRef<HTMLDivElement>(null), pathname = usePathname();
  useAppNavigationEnvironment(environment);
  useAppNavigationGuard(() => busy ? "Wait for the current funnel update to finish before leaving." : !dirty || window.confirm("Leave this page and discard unsaved funnel edits?"));
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => { if (!dirty) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, [dirty]);
  return <main className="funnel-workspace mx-auto max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8 space-y-6" onClickCapture={event => {
    const href = (event.target as HTMLElement).closest("a")?.getAttribute("href");
    if (dirty && href && !href.startsWith("#") && !event.metaKey && !event.ctrlKey && !window.confirm("Leave this page and discard unsaved funnel edits?")) event.preventDefault();
  }}>
    <a href="#funnel-content" className="sr-only focus:not-sr-only focus:btn">Skip to workspace</a>
    <div className="flex flex-wrap items-center justify-between gap-3"><Link prefetch={false} className="btn btn-ghost min-h-11 normal-case" href={environment ? `/funnels?environment=${environment}` : "/funnels"}>All funnels</Link><AccountNavigation signedIn={!error?.includes("session ended")} busy={busy || dirty} onError={onError} /></div>
    <header className="space-y-2 min-w-0"><div className="flex flex-wrap items-center gap-3"><h1 className="text-3xl font-semibold tracking-tight break-words min-w-0">{title}</h1>
      {environment && <span className="badge badge-outline">{environment}</span>}</div>
      {description && <p className="max-w-4xl text-base-content/75">{description}</p>}
      {environment === "TEST" && <p className="text-sm">Test environment. Test evidence does not prove live provider setup or delivery.</p>}</header>
    {error && <div ref={errorRef} tabIndex={-1} role="alert" className="rounded-box border border-error p-4 break-words focus:outline focus:outline-2 focus:outline-error">{error}
      {error.includes("session ended") && <Link className="underline ml-2" target="_blank" href={`/sign-in?returnTo=${encodeURIComponent(pathname)}`}>Sign in in another tab</Link>}</div>}
    {notice && <p role="status" className="rounded-box border border-success p-3">{notice}</p>}
    <div id="funnel-content" className="min-w-0" aria-busy={busy || loading}>{loading ? <p role="status">Loading workspace…</p> : children}</div>
    {busy && <p role="status" aria-live="polite">Updating workspace…</p>}
  </main>;
}
