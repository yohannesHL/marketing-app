import type { SVGProps } from "react";
export type WorkspaceIconName = "home" | "campaigns" | "chat" | "workflow" | "studio" | "affiliate" | "social" | "analytics" | "settings" | "search" | "plus" | "chevron" | "collapse" | "more" | "arrow" | "logout";
const paths: Record<WorkspaceIconName, React.ReactNode> = {
  home: <><path d="m3 10 9-7 9 7v10H3Z"/><path d="M9 20v-7h6v7"/></>,
  campaigns: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 9v11m4-7h5m-5 3h3"/></>,
  chat: <><path d="M4 4h16v12H9l-5 4Z"/><path d="M8 8h8m-8 4h5"/></>,
  workflow: <><rect x="2" y="9" width="6" height="6" rx="1"/><rect x="16" y="2" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><path d="M8 12h4V5h4m-4 7v7h4"/></>,
  studio: <><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-5 4 3 4-5 4 5"/></>,
  affiliate: <><path d="m9 15 6-6m-7 3-2 2a4 4 0 0 0 6 6l2-2m-4-12 2-2a4 4 0 0 1 6 6l-2 2"/></>,
  social: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 2v6m10-6v6M3 11h18m-13 4h2m4 0h2"/></>,
  analytics: <><path d="M4 3v17h17M8 15l4-5 4 2 5-7"/></>,
  settings: <><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
  plus: <path d="M12 5v14M5 12h14"/>, chevron: <path d="m9 5 7 7-7 7"/>,
  collapse: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16m7-12-3 4 3 4"/></>,
  more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>, logout: <><path d="M10 4H4v16h6m0-8h11m-5-5 5 5-5 5"/></>,
};
export function WorkspaceIcon({ name, ...props }: SVGProps<SVGSVGElement> & { name: WorkspaceIconName }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>;
}
