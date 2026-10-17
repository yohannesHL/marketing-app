"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { connectionRequest, ConnectionUiError } from "../connections/connectionUi";
import { WorkspaceIcon, type WorkspaceIconName } from "./WorkspaceIcon";

type Guard = (href: string) => void;
const NavigationGuard = createContext<(guard?: Guard) => (() => void)>(() => () => {});
/** Lets an editor preserve its existing unsaved-change dialog for global navigation. */
export function useWorkspaceNavigationGuard(guard?: Guard) {
  const register = useContext(NavigationGuard);
  useEffect(() => register(guard), [guard, register]);
}
const navigation: { label: string; icon: WorkspaceIconName; href?: string }[] = [
  { label: "Home", icon: "home", href: "/dashboard" },
  { label: "AI Copilot", icon: "chat" },
  { label: "Campaigns", icon: "campaigns", href: "/campaigns" },
  { label: "Workflows", icon: "workflow" },
  { label: "Content Studio", icon: "studio", href: "/studio" },
  { label: "Affiliate marketing", icon: "affiliate" },
  { label: "Social marketing", icon: "social", href: "/social" },
  { label: "Analytics & insights", icon: "analytics" },
];
const actions = [
  { label: "Create a campaign", description: "Start with your website and a brief", href: "/campaigns/create", icon: "plus" },
  { label: "Campaign library", description: "Find and manage campaigns", href: "/campaigns", icon: "campaigns" },
  { label: "Create a social post", description: "Write, review and schedule", href: "/social/create", icon: "social" },
  { label: "Publishing calendar", description: "Review your upcoming posts", href: "/social", icon: "social" },
  { label: "Content Studio", description: "Manage your creative assets", href: "/studio", icon: "studio" },
  { label: "Integrations / channels", description: "Connect your marketing accounts", href: "/connections", icon: "settings" },
] satisfies { label: string; description: string; href: string; icon: WorkspaceIconName }[];
export function AppShell({ children, mockMode = false }: { children: ReactNode; mockMode?: boolean }) {
  const pathname = usePathname();
  const protectedPage = /^\/(dashboard|campaigns|studio|social|connections)(\/|$)/.test(pathname);
  const [session, setSession] = useState<{ customerId: string; displayName?: string } | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [more, setMore] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const guardRef = useRef<Guard>();
  const searchRef = useRef<HTMLInputElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const moreNavRef = useRef<HTMLElement>(null);
  const searchPanelRef = useRef<HTMLDivElement>(null);
  const register = useCallback((guard?: Guard) => {
    guardRef.current = guard;
    return () => { if (guardRef.current === guard) guardRef.current = undefined; };
  }, []);
  useEffect(() => {
    if (!protectedPage) return;
    let active = true;
    setError("");
    connectionRequest<{ customerId: string; displayName?: string }>("/api/auth/session").then((value) => {
      if (active) setSession(value);
    }).catch((failure) => {
      if (!active) return;
      if (failure instanceof ConnectionUiError && failure.status === 401) window.location.replace(`/sign-in?returnTo=${encodeURIComponent(pathname + window.location.search)}`);
      else setError("We couldn’t open your workspace. Check your connection and try again.");
    });
    return () => { active = false; };
  }, [protectedPage, pathname, retry]);
  useEffect(() => { setMore(false); setSearchOpen(false); setQuery(""); }, [pathname]);
  useEffect(() => {
    if (more) moreNavRef.current?.querySelector<HTMLAnchorElement>("a[href]")?.focus();
  }, [more]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault(); searchRef.current?.focus(); setSearchOpen(true);
      }
      if (event.key === "Escape") {
        if (moreNavRef.current?.contains(document.activeElement)) moreButtonRef.current?.focus();
        if (searchPanelRef.current?.contains(document.activeElement)) searchRef.current?.focus();
        setSearchOpen(false); setMore(false);
      }
    };
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, []);
  async function signOut() {
    if (guardRef.current && !window.confirm("Sign out and leave this editor? Any unsaved changes will be lost.")) return;
    setSigningOut(true);
    try { await connectionRequest("/api/auth/session", "DELETE"); window.location.assign("/sign-in"); }
    catch { setError("We couldn’t sign you out. Please try again."); setSigningOut(false); }
  }
  if (!protectedPage) return <>{children}</>;
  const current = navigation.find((item) => item.href && (pathname === item.href || pathname.startsWith(`${item.href}/`)));
  const pageLabel = pathname.startsWith("/connections") ? "Integrations / channels" : current?.label ?? "Workspace";
  const navItems = navigation.map((item) => item.href ? <Link key={item.label} href={item.href} prefetch={false} className="workspace-nav-item" title={collapsed ? item.label : undefined} aria-current={current?.href === item.href ? "page" : undefined}><WorkspaceIcon name={item.icon}/><span>{item.label}</span></Link> : <button key={item.label} type="button" className="workspace-nav-item workspace-nav-future" disabled title={`${item.label} · Coming soon`}><WorkspaceIcon name={item.icon}/><span>{item.label}</span><small>Soon</small></button>);
  return <NavigationGuard.Provider value={register}><div className={`workspace-shell ${collapsed ? "is-collapsed" : ""}`} onClickCapture={(event) => {
    if (!guardRef.current || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = (event.target as HTMLElement).closest("a");
    const href = link?.getAttribute("href");
    if (href?.startsWith("/") && !href.startsWith("//") && !link?.target) { event.preventDefault(); guardRef.current(href); }
  }}>
    <a className="skip-link" href="#workspace-content">Skip to content</a>
    <aside className="workspace-sidebar" aria-label="Workspace sidebar">
      <Link className="workspace-brand" href="/dashboard" aria-label="Launchpad dashboard"><span className="brand-symbol">l<span>p</span></span><span>launchpad<span className="brand-period">.</span></span></Link>
      <div className="workspace-label">Workspace</div>
      <nav aria-label="Global navigation">{navItems}</nav>
      <div className="workspace-sidebar-bottom"><Link href="/connections" className="workspace-nav-item" aria-label="Integrations / channels" aria-current={pathname.startsWith("/connections") ? "page" : undefined}><WorkspaceIcon name="settings"/><span>Integrations / channels</span></Link>
      <button type="button" className="workspace-nav-item" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed}><WorkspaceIcon name="collapse"/><span>Collapse sidebar</span></button>
      <div className="workspace-account"><span className="workspace-avatar">{session?.displayName?.slice(0, 1).toUpperCase() || "W"}</span><div><strong>{session?.displayName || "Your workspace"}</strong><span>Marketing workspace</span></div><button type="button" className="icon-button" title="Sign out" aria-label="Sign out" onClick={signOut} disabled={signingOut}><WorkspaceIcon name="logout"/></button></div></div>
    </aside>
    <div className="workspace-body"><header className="workspace-topbar"><nav aria-label="Breadcrumb" className="workspace-breadcrumb"><Link href="/dashboard">Workspace</Link><WorkspaceIcon name="chevron"/><span>{pageLabel}</span></nav>
      {mockMode ? <span className="workspace-mode" title="Test data; no live publishing"><span className="status-dot"/>Mockoon workspace</span> : null}
      <div className="workspace-command-search" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setSearchOpen(false); }}><WorkspaceIcon name="search"/><input ref={searchRef} aria-label="Search quick actions" placeholder="Search or jump to…" value={query} onChange={(event) => { setQuery(event.target.value); setSearchOpen(true); }} onFocus={() => setSearchOpen(true)} aria-controls={searchOpen ? "quick-actions" : undefined}/><kbd>⌘ K</kbd>
      {searchOpen ? <div id="quick-actions" ref={searchPanelRef} className="quick-actions"><span className="eyebrow">Quick actions</span>{actions.filter((item) => `${item.label} ${item.description}`.toLowerCase().includes(query.toLowerCase())).map((item) => <Link href={item.href} key={item.href}><WorkspaceIcon name={item.icon}/><span><strong>{item.label}</strong><small>{item.description}</small></span><WorkspaceIcon name="arrow"/></Link>)}{!actions.some((item) => `${item.label} ${item.description}`.toLowerCase().includes(query.toLowerCase())) ? <p>No matching actions. Try “campaign” or “social”.</p> : null}</div> : null}</div>
      <Link href="/campaigns/create" className="button button-primary topbar-create"><WorkspaceIcon name="plus"/>Create campaign</Link></header>
      <main id="workspace-content" tabIndex={-1} className="workspace-main">{error ? <div role="alert" className="workspace-error">{error}<button className="button" onClick={() => setRetry(retry + 1)}>Try again</button></div> : null}{session ? children : !error ? <div className="workspace-page workspace-loading" role="status"><span className="skeleton-line"/><span className="skeleton-block"/><span className="sr-only">Opening your workspace…</span></div> : null}</main>
    </div>
    {more ? <nav id="workspace-mobile-more" ref={moreNavRef} aria-label="More workspace navigation" className="workspace-mobile-more" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node) && event.relatedTarget !== moreButtonRef.current) setMore(false); }}>{navItems}<Link className="workspace-nav-item" href="/connections"><WorkspaceIcon name="settings"/>Integrations / channels</Link><button type="button" className="workspace-nav-item" disabled={signingOut} onClick={signOut}><WorkspaceIcon name="logout"/>Sign out</button></nav> : null}
    <nav aria-label="Mobile navigation" className="workspace-mobile-nav">{[{ label: "Home", href: "/dashboard", icon: "home" }, { label: "Campaigns", href: "/campaigns", icon: "campaigns" }, { label: "Create", href: "/campaigns/create", icon: "plus" }, { label: "Social", href: "/social", icon: "social" }].map((item) => <Link key={item.label} href={item.href} aria-current={pathname === item.href ? "page" : undefined}><WorkspaceIcon name={item.icon as WorkspaceIconName}/><span>{item.label}</span></Link>)}<button ref={moreButtonRef} type="button" onClick={() => setMore(!more)} aria-expanded={more} aria-controls={more ? "workspace-mobile-more" : undefined}><WorkspaceIcon name="more"/><span>More</span></button></nav>
  </div></NavigationGuard.Provider>;
}
