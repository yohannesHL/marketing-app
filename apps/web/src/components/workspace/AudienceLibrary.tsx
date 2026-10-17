"use client";
import Link from "next/link";
import type { CampaignDTO } from "../../server/workspace/types";
import { useWorkspaceResource } from "./workspaceClient";
import { PageHeading, LoadingView, ErrorView, EmptyView } from "./WorkspaceViews";
export function AudienceLibrary(){
 const {data,error,loading,reload}=useWorkspaceResource<{campaigns:CampaignDTO[]}>("/api/workspace/campaigns");
 const rows=data?.campaigns.filter(c=>c.audience.trim())??[];
 return <div className="workspace-page"><Link href="/campaigns" className="text-action back-link">← Campaigns</Link><PageHeading eyebrow="Campaigns" title="Audience segments" description="The audience definitions saved with your campaigns. CRM sync and predictive lead scoring are not connected yet."/>{error?<ErrorView message={error} retry={()=>void reload()}/>:loading?<LoadingView/>:rows.length?<div className="audience-grid">{rows.map(c=><article key={c.id} className="panel panel-body"><span className="eyebrow">{c.name}</span><h2>{c.goal || "Campaign audience"}</h2><p>{c.audience}</p><Link href={`/campaigns/create?id=${c.id}`} className="text-action">Edit audience →</Link></article>)}</div>:<section className="panel"><EmptyView title="Define who you want to reach" href="/campaigns/create">Add an audience to a campaign and it will appear here.</EmptyView></section>}</div>;
}
