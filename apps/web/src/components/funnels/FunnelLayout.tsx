"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";
import { AccountNavigation } from "../connections/AccountNavigation";
import type { Environment } from "./funnelUi";
import { WorkspaceTheme } from "./WorkspaceTheme";

export function FunnelLayout({ title, description, environment, children, loading, busy, error, notice, onError, dirty = false }: {
  title: string; description?: string; environment?: Environment; children: ReactNode; loading?: boolean; busy?: boolean;
  error?: string | null; notice?: string | null; onError?: (error: unknown) => void; dirty?: boolean;
}) {
  const errorRef = useRef<HTMLDivElement>(null), pathname = usePathname();
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => { if (!dirty) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, [dirty]);
  return <WorkspaceTheme><main className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8 space-y-6" onClickCapture={event => {
    const href = (event.target as HTMLElement).closest("a")?.getAttribute("href");
    if (dirty && href && !href.startsWith("#") && !event.metaKey && !event.ctrlKey && !window.confirm("Leave this page and discard unsaved funnel edits?")) event.preventDefault();
  }}>
    <a href="#funnel-content" className="sr-only focus:not-sr-only focus:btn">Skip to workspace</a>
    <AccountNavigation signedIn={!error?.includes("session ended")} busy={busy || dirty} onError={onError} />
    <nav aria-label="Journey workspace" className="flex flex-wrap gap-2">
      <Link className="btn btn-ghost min-h-11 normal-case" href="/funnels">Funnels</Link>
      <Link className="btn btn-ghost min-h-11 normal-case" href={`/tracking${environment ? `?environment=${environment}` : ""}`}>Tracking sources</Link>
      <Link className="btn btn-ghost min-h-11 normal-case" href={`/email${environment ? `?environment=${environment}` : ""}`}>Email campaigns</Link>
    </nav>
    <header className="space-y-2 min-w-0"><div className="flex flex-wrap items-center gap-3"><h1 className="text-3xl font-semibold tracking-tight break-words min-w-0">{title}</h1>
      {environment && <span className="badge badge-outline">{environment}</span>}</div>
      {description && <p className="max-w-4xl text-base-content/75">{description}</p>}
      {environment === "TEST" && <p className="text-sm">Test environment. Test evidence does not prove live provider setup or delivery.</p>}</header>
    {error && <div ref={errorRef} tabIndex={-1} role="alert" className="rounded-box border border-error p-4 break-words focus:outline focus:outline-2 focus:outline-error">{error}
      {error.includes("session ended") && <Link className="underline ml-2" target="_blank" href={`/sign-in?returnTo=${encodeURIComponent(pathname)}`}>Sign in in another tab</Link>}</div>}
    {notice && <p role="status" className="rounded-box border border-success p-3">{notice}</p>}
    <div id="funnel-content" className="min-w-0" aria-busy={busy || loading}>{loading ? <p role="status">Loading workspace…</p> : children}</div>
    {busy && <p role="status" aria-live="polite">Updating workspace…</p>}
  </main></WorkspaceTheme>;
}
