"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { CampaignDTO, WorkspaceSummary } from "../../server/workspace/types";
import { campaignTypes, readable, useWorkspaceResource, workspaceRequest } from "./workspaceClient";
import { PageHeading, LoadingView, ErrorView, Status } from "./WorkspaceViews";
import { CampaignExecution } from "./CampaignExecution";
import { SocialReview } from "../social/SocialReview";
import { SocialDeliveries } from "../social/SocialDeliveries";
import { socialRequest, type SocialPost } from "../social/socialUi";
export function CampaignDetail({id}: {id:string}) {
  const {data,setData,error,loading,reload} = useWorkspaceResource<{campaign:CampaignDTO}>(`/api/workspace/campaigns/${encodeURIComponent(id)}`);
  const [failure,setFailure] = useState<string|null>(null), [notice,setNotice] = useState<string|null>(null), [busy,setBusy] = useState(false), [available,setAvailable] = useState<WorkspaceSummary["posts"]>([]), [chosen,setChosen] = useState("");
  const campaign = data?.campaign;
  useEffect(() => { workspaceRequest<WorkspaceSummary>("/api/workspace/summary").then(value => setAvailable(value.posts)).catch(()=>{}); }, []);
  async function update(patch: object) {
    if (!campaign || busy) return;
    setBusy(true); setFailure(null); setNotice(null);
    try { setData(await workspaceRequest<{campaign:CampaignDTO}>(`/api/workspace/campaigns/${id}`,"PATCH",{...patch,version:campaign.version})); setNotice("Campaign updated."); }
    catch(e) { setFailure(e instanceof Error ? e.message : "The campaign could not be updated."); }
    finally { setBusy(false); }
  }
  if (error) return <div className="workspace-page"><ErrorView message={error} retry={()=>void reload()} /></div>;
  if (loading || !campaign) return <div className="workspace-page"><LoadingView /></div>;
  return <div className="workspace-page"><Link href="/campaigns" className="text-action back-link">← All campaigns</Link><PageHeading eyebrow={campaignTypes[campaign.type]} title={campaign.name} description={readable(campaign.goal) || "Shape this campaign’s objective in the builder."} action={<><Status value={campaign.status} /><Link className="btn btn-primary" href={`/campaigns/create?id=${id}`}>Edit campaign</Link></>} />
    {failure && <ErrorView message={failure} />}{notice && <p role="status" className="workspace-notice">{notice}</p>}
    <div className="campaign-detail-grid"><section className="panel"><div className="panel-heading"><h2>The brief</h2><span className="eyebrow">Version {campaign.version}</span></div><div className="panel-body"><p className="preserve-lines">{campaign.brief || "Add a brief to explain the offer, audience, and desired outcome."}</p><dl className="workspace-definition"><div><dt>Website</dt><dd>{campaign.websiteUrl ? <a href={campaign.websiteUrl} target="_blank" rel="noreferrer">{campaign.websiteUrl} ↗</a> : "Not added"}</dd></div><div><dt>Audience</dt><dd>{campaign.audience || "Not defined"}</dd></div><div><dt>Channels</dt><dd>{campaign.platforms.map(readable).join(" · ") || "Not selected"}</dd></div></dl></div></section><aside className="panel"><div className="panel-heading"><h2>Execution</h2></div><div className="panel-body"><span className="workspace-status">{campaign.type === "SOCIAL" ? "Approved content delivery" : campaign.type === "ADS" ? "Ad account readiness" : "Drafting workspace"}</span><p>{campaign.execution.message}</p>{campaign.type === "SOCIAL" ? <p>Review each saved post below. Once scheduled, the publishing worker handles delivery and records the outcome for each destination.</p> : <Link href="/connections" className="text-action">Manage integrations →</Link>}<button className="btn btn-secondary" disabled={busy} onClick={()=>void update({status:campaign.status === "ARCHIVED" ? "DRAFT" : "ARCHIVED"})}>{campaign.status === "ARCHIVED" ? "Restore to drafts" : "Archive campaign"}</button>{campaign.type === "SOCIAL" && <p className="field-help">Archiving only moves this campaign out of your active library. To stop scheduled posts, cancel their deliveries below.</p>}</div></aside></div>
    {campaign.type === "ADS" && <section className="panel panel-body"><CampaignExecution type={campaign.type} platforms={campaign.platforms} campaignId={id}/></section>}
    {Object.keys(campaign.plan).length > 0 && <section className="panel"><div className="panel-heading"><h2>Campaign plan</h2></div><dl className="plan-facts">{Object.entries(campaign.plan).filter(([key,v])=>(campaign.type === "ADS" || key !== "currency") && (typeof v === "string" || typeof v === "number")).map(([key,value])=><div key={key}><dt>{readable(key.replace(/([A-Z])/g," $1"))}</dt><dd>{String(value) || "Not set"}</dd></div>)}</dl></section>}
    <section className="panel"><div className="panel-heading"><div><p className="eyebrow">Creative direction</p><h2>Campaign content</h2></div><Link href={`/campaigns/create?id=${id}`} className="text-action">Edit content ↗</Link></div><div className="creative-preview-list">{campaign.creatives.length ? campaign.creatives.map((creative,index)=><article key={index}><div className="creative-preview-heading"><span className="eyebrow">{String(creative.platform ?? creative.channel ?? `Creative ${index + 1}`)}</span><span className="workspace-status">Draft</span></div>{Object.entries(creative).filter(([key,value])=>!['platform','channel','id'].includes(key) && typeof value === 'string' && value).map(([key,value])=><div key={key}><span className="creative-field-label">{readable(key)}</span><p className="preserve-lines">{String(value)}</p></div>)}</article>) : <p className="quiet-copy">No creative drafts yet. Add copy in the campaign builder.</p>}</div></section>
    {campaign.type === "SOCIAL" && <section className="campaign-posts"><div className="panel-heading"><div><p className="eyebrow">Review & delivery</p><h2>Social publishing plan</h2></div><Link className="btn btn-primary" href={`/social/create?campaignId=${id}`}>＋ Prepare social post</Link></div><p className="page-description">Campaign copy carries into the composer. Add media and destination settings, then review the exact saved content before scheduling.</p>
      <div className="attach-post-row"><label htmlFor="attach-post">Add an existing post</label><select id="attach-post" value={chosen} disabled={busy} onChange={e=>setChosen(e.target.value)}><option value="">Choose a post…</option>{available.filter(p=>!campaign.socialPostIds.includes(p.id)).map(post=><option key={post.id} value={post.id}>{post.title}</option>)}</select><button className="btn btn-secondary" disabled={!chosen || busy} onClick={()=>void update({socialPostIds:[...campaign.socialPostIds,chosen]}).then(()=>setChosen(""))}>Add to campaign</button></div>
      {campaign.linkedPosts.length ? campaign.linkedPosts.map(post=><CampaignPostReview key={post.id} id={post.id} title={post.title} status={post.status} />) : <div className="panel quiet-empty"><h3>Turn the brief into your first post.</h3><p>Your campaign is saved. Prepare the content and choose the connected accounts it should reach.</p></div>}
    </section>}
  </div>;
}
function CampaignPostReview({id,title,status}: {id:string;title:string;status:string}) {
  const [open,setOpen]=useState(false),[post,setPost]=useState<SocialPost|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null);
  const tracking = Boolean(post?.deliveries.some(delivery => ["QUEUED", "LEASED", "RETRY_WAIT", "UNCERTAIN"].includes(delivery.status)));
  useEffect(() => {
    if (!open || busy || !tracking) return;
    let active = true; let refreshing = false;
    const timer = window.setInterval(async () => {
      if (document.hidden || refreshing) return;
      refreshing = true;
      try { const value = await socialRequest<SocialPost>(`/api/social/posts/${id}`); if(active) {setPost(value);setError(null);} }
      catch { if(active)setError("Delivery status could not refresh. Your saved schedule is unchanged."); }
      finally { refreshing = false; }
    }, 5000);
    return () => {active=false;window.clearInterval(timer);};
  },[id,open,busy,tracking]);
  async function action(work:()=>Promise<void>) { if(busy)return; setBusy(true);setError(null);try{await work();}catch(e){setError(e instanceof Error?e.message:"The post could not be updated.");}finally{setBusy(false);} }
  async function load() { await action(async()=>setPost(await socialRequest<SocialPost>(`/api/social/posts/${id}`))); }
  return <article className="panel campaign-post-review"><div className="panel-heading"><div><h3>{title}</h3><Status value={post?.status ?? status}/></div><div className="page-actions"><Link href={`/social/posts/${id}`} className="text-action">Edit post ↗</Link><button className="btn btn-secondary" aria-expanded={open} disabled={busy} onClick={()=>{setOpen(!open);if(!open)void load();}}>{open?"Close review":"Review & schedule"}</button></div></div>{open && <div className="panel-body">{error&&<ErrorView message={error}/>} {notice&&<p role="status" className="workspace-notice">{notice}</p>}{post ? <>{tracking && <p role="status" className="workspace-notice">Delivery runs in the background. You can close this page; status refreshes here while it is open.</p>}<SocialReview key={post.revision.id} post={post} busy={busy} onAction={action} onUpdate={setPost} onNotice={setNotice}/><SocialDeliveries post={post} busy={busy} onAction={action} onUpdate={setPost}/></> : <LoadingView/>}</div>}</article>;
}
