"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { WorkspaceTheme } from "../funnels/WorkspaceTheme";
import "./app-navigation.css";

type NavigationEnvironment = "TEST" | "LIVE";
const NavigationEnvironment = createContext<(environment: NavigationEnvironment) => void>(() => {});

/** Keep environment-aware destinations on the environment selected in the current section. */
export function useAppNavigationEnvironment(environment?: NavigationEnvironment) {
  const setEnvironment = useContext(NavigationEnvironment);
  useEffect(() => { if (environment) setEnvironment(environment); }, [environment, setEnvironment]);
}

type NavigationGuard = (href: string) => boolean | string;
const NavigationGuards = createContext<(guard: NavigationGuard) => () => void>(() => () => {});

/** Let each editor preserve its own save/discard behavior for the shared menu. */
export function useAppNavigationGuard(guard: NavigationGuard) {
  const register = useContext(NavigationGuards), latest = useRef(guard);
  latest.current = guard;
  useEffect(() => register(href => latest.current(href)), [register]);
}

const destinations = [
  { href: "/", label: "Home" },
  { href: "/campaigns/create", label: "Campaigns", prefix: "/campaigns" },
  { href: "/social", label: "Social publishing" },
  { href: "/email", label: "Email campaigns" },
  { href: "/funnels", label: "Funnels" },
  { href: "/tracking", label: "Tracking sources" },
  { href: "/connections", label: "Connections" },
];

export function AppShell({ children }: { children: ReactNode }) {
  const [environment, setEnvironment] = useState<NavigationEnvironment>();
  const pathname = usePathname(), guards = useRef(new Set<NavigationGuard>());
  const [menuOpen, setMenuOpen] = useState(false), [notice, setNotice] = useState<string | null>(null);
  const register = useCallback((guard: NavigationGuard) => {
    guards.current.add(guard);
    return () => { guards.current.delete(guard); };
  }, []);
  useEffect(() => { setMenuOpen(false); setNotice(null); }, [pathname]);
  function navigate(event: MouseEvent<HTMLElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = (event.target as HTMLElement).closest("a"), href = link?.getAttribute("href");
    if (!href || link?.target || !href.startsWith("/")) return;
    for (const guard of guards.current) {
      const decision = guard(href);
      if (decision !== true) {
        event.preventDefault(); event.stopPropagation();
        setNotice(typeof decision === "string" ? decision : null);
        return;
      }
    }
    setNotice(null); setMenuOpen(false);
  }
  return <NavigationEnvironment.Provider value={setEnvironment}><NavigationGuards.Provider value={register}><WorkspaceTheme navigation={
    <header className="app-header" onClickCapture={navigate}>
      <div className="app-header-bar"><Link prefetch={false} className="app-brand" href="/" aria-label="LaunchPad home">LaunchPad</Link>
        <button type="button" className="app-menu-toggle btn btn-ghost min-h-11 normal-case" aria-expanded={menuOpen} aria-controls="main-navigation" onClick={() => setMenuOpen(open => !open)}>Main menu</button>
        <nav id="main-navigation" aria-label="Main navigation" className={`app-main-navigation ${menuOpen ? "is-open" : ""}`}>
          {destinations.map(item => { const prefix = item.prefix ?? item.href, active = prefix === "/" ? pathname === "/" : pathname === prefix || pathname.startsWith(`${prefix}/`);
            return <Link key={item.href} prefetch={false} href={environment && ["/funnels", "/email", "/tracking"].includes(item.href) ? `${item.href}?environment=${environment}` : item.href} aria-current={active ? "page" : undefined} className="app-nav-link">{item.label}</Link>;
          })}
        </nav>
      </div>
      {notice && <p role="status" className="app-navigation-notice">{notice}</p>}
    </header>
  }>{children}</WorkspaceTheme></NavigationGuards.Provider></NavigationEnvironment.Provider>;
}
