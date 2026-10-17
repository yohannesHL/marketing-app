"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import type { CampaignDTO } from "../../server/workspace/types";
import { campaignTypes, dateLabel, readable } from "./workspaceClient";
export function PageHeading({ eyebrow, title, description, action }: {eyebrow: string; title: string; description?: string; action?: ReactNode}) {
  return <header className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1>{description && <p className="page-description">{description}</p>}</div>{action && <div className="page-actions">{action}</div>}</header>;
}
export function LoadingView() { return <div className="workspace-skeleton" role="status" aria-label="Loading workspace"><span /><span /><span /><span /></div>; }
export function ErrorView({ message, retry }: {message: string; retry?: () => void}) { return <div className="workspace-error" role="alert"><strong>We couldn’t finish that request</strong><p>{message}</p>{retry && <button className="btn btn-secondary" onClick={retry}>Try again</button>}</div>; }
export function EmptyView({ title, children, href, action }: {title: string; children: ReactNode; href?: string; action?: string}) { return <div className="workspace-empty"><div className="empty-line-icon" aria-hidden="true">＋</div><h2>{title}</h2><p>{children}</p>{href && <Link className="btn btn-primary" href={href}>{action ?? "Create campaign"}</Link>}</div>; }
export function Status({ value }: { value: string }) { return <span className={`workspace-status status-${value.toLowerCase()}`}>{readable(value)}</span>; }
export function CampaignTable({ campaigns, compact = false }: {campaigns: CampaignDTO[]; compact?: boolean}) {
  return <div className="workspace-table-scroll"><table className={`workspace-table ${compact ? "workspace-table-compact" : ""}`}><thead><tr><th>Campaign</th><th>Type</th><th>Status</th><th>Channels</th><th>Updated</th><th><span className="sr-only">Open campaign</span></th></tr></thead><tbody>{campaigns.map(campaign => <tr key={campaign.id}><td><Link className="table-name" href={`/campaigns/${campaign.id}`}>{campaign.name || "Untitled campaign"}</Link><span className="table-subtext">{readable(campaign.goal) || "Define a campaign goal"}</span></td><td>{campaignTypes[campaign.type]}</td><td><Status value={campaign.status} /></td><td>{campaign.platforms.map(readable).join(", ") || "Not selected"}</td><td className="numeric"><time dateTime={campaign.updatedAt}>{dateLabel(campaign.updatedAt)}</time></td><td><Link className="row-open" href={`/campaigns/${campaign.id}`} aria-label={`Open ${campaign.name}`}>↗</Link></td></tr>)}</tbody></table></div>;
}
