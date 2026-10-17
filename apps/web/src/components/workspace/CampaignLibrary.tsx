"use client";
import Link from "next/link";
import { useState } from "react";
import type { CampaignDTO } from "../../server/workspace/types";
import { useWorkspaceResource, campaignTypes } from "./workspaceClient";
import { CampaignTable, EmptyView, ErrorView, LoadingView, PageHeading } from "./WorkspaceViews";
import { SocialCalendar } from "../social/SocialCalendar";
export function CampaignLibrary() {
  const {data,loading,error,reload} = useWorkspaceResource<{campaigns:CampaignDTO[]}>("/api/workspace/campaigns");
  const [query,setQuery] = useState(""), [type,setType] = useState("ALL"), [status,setStatus] = useState("ALL"), [view,setView] = useState("list");
  const rows = data?.campaigns.filter(c => (type === "ALL" || c.type === type) && (status === "ALL" || c.status === status) && `${c.name} ${c.brief} ${c.platforms.join(" ")}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  return <div className="workspace-page"><PageHeading eyebrow="Plan. Create. Publish." title="Campaigns" description="Your campaign library, from the first brief to the next delivery." action={<Link href="/campaigns/create" className="btn btn-primary">＋ Create campaign</Link>} />
    <div className="module-tabs" role="group" aria-label="Campaign views"><button aria-pressed={view === "list"} onClick={() => setView("list")}>List view</button><button aria-pressed={view === "calendar"} onClick={() => setView("calendar")}>Calendar view</button><button disabled title="AI mind-map is coming later">AI mind-map <span>Coming soon</span></button><Link href="/campaigns/audiences">Audience segments ↗</Link></div>
    {view === "calendar" ? <div className="campaign-calendar"><SocialCalendar embedded /></div> : <><div className="workspace-toolbar"><label className="workspace-search"><span className="sr-only">Search campaigns</span><input placeholder="Search campaigns…" value={query} onChange={e=>setQuery(e.target.value)} /></label><label>Type<select value={type} onChange={e=>setType(e.target.value)}><option value="ALL">All types</option>{Object.entries(campaignTypes).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label>Status<select value={status} onChange={e=>setStatus(e.target.value)}><option value="ALL">All statuses</option><option value="DRAFT">Draft</option><option value="READY">Ready</option><option value="ARCHIVED">Archived</option></select></label></div>
    {error ? <ErrorView message={error} retry={() => void reload()} /> : loading ? <LoadingView /> : rows.length ? <section className="panel"><CampaignTable campaigns={rows} /><div className="table-footer">{rows.length} campaign{rows.length === 1 ? "" : "s"}</div></section> : <section className="panel"><EmptyView title={data?.campaigns.length ? "No campaigns match these filters" : "Every campaign starts with a clear brief"} href={data?.campaigns.length ? undefined : "/campaigns/create"}>{data?.campaigns.length ? "Try another name, type, or status." : "Tell us what you’re promoting and who it’s for. Build the plan one step at a time."}</EmptyView></section>}</>}
  </div>;
}
