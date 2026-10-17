"use client";
import { useEffect, useState, type ReactNode } from "react";
export function WorkspaceTheme({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState("light");
  useEffect(() => { try { if (localStorage.getItem("launchpad-workspace-theme") === "dark") setTheme("dark"); } catch { /* Storage is optional. */ } }, []);
  return <div data-theme={`launchpad-${theme}`} className="min-h-screen bg-base-200 text-base-content [&_.btn-ghost:not(:disabled):not(.btn-disabled)]:text-base-content" style={{ colorScheme: theme }}>
    <div className="mx-auto max-w-[1600px] flex justify-end px-4 pt-3 sm:px-6"><label className="flex items-center gap-3 text-sm">Appearance<select className="select select-bordered min-h-11" value={theme} onChange={e => { const value = e.target.value; setTheme(value); try { localStorage.setItem("launchpad-workspace-theme", value); } catch { /* Continue without persistence. */ } }}><option value="light">Light</option><option value="dark">Dark</option></select></label></div>
    {children}
  </div>;
}
