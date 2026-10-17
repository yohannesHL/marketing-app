"use client";
import { useCallback, useEffect, useState } from "react";
export class WorkspaceError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}
export async function workspaceRequest<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(path, { method, credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && typeof window !== "undefined") window.location.assign(`/sign-in?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    throw new WorkspaceError(data?.code ?? "REQUEST_FAILED", data?.message ?? "We couldn’t load your workspace. Try again.", response.status);
  }
  return data as T;
}
export function useWorkspaceResource<T>(path: string) {
  const [data, setData] = useState<T | null>(null), [error, setError] = useState<string | null>(null), [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true); setError(null);
    try { const result = await workspaceRequest<T>(path); setData(result); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "We couldn’t load this view."); }
    finally { setLoading(false); }
  }, [path]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, setData, error, loading, reload };
}
export const campaignTypes = { SOCIAL: "Social", ADS: "Paid advertising", EMAIL: "Email", BLOG: "Blog" } as const;
export function readable(value: string) { const labels: Record<string,string> = {YOUTUBE:"YouTube Shorts",FACEBOOK:"Facebook",INSTAGRAM:"Instagram",TIKTOK:"TikTok",LINKEDIN:"LinkedIn",X:"X",GOOGLE:"Google Ads",META:"Meta Ads",EMAIL:"Email",BLOG:"Blog",cta:"Call to action",script:"Video script",visualBrief:"Visual direction",cadence:"Posts per week",awareness:"Build awareness",traffic:"Website traffic",leads:"Generate enquiries",sales:"Drive sales",engagement:"Grow the community"}; return labels[value] ?? value.toLowerCase().replaceAll("_", " ").replace(/^./, c => c.toUpperCase()); }
export function dateLabel(value: string) { return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(value)); }
