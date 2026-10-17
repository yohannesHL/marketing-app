"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { campaignChannels, campaignFromDTO, campaignStepError, campaignTypes, changeCampaignType, emptyCampaign, structureCampaignBrief, syncCampaignCreatives, type CampaignBuilderState, type CampaignCreative } from "./campaignBuilderState";
import type { BrandDTO, CampaignDTO } from "../../server/workspace/types";
import { CampaignExecution } from "./CampaignExecution";
import { useWorkspaceNavigationGuard } from "./AppShell";
import styles from "./campaignBuilder.module.css";

const steps = ["Type", "Brief", "Audience", "Channels", "Plan", "Creatives", "Review"];
const goals = [{ id: "awareness", label: "Build awareness" }, { id: "traffic", label: "Bring people to my website" }, { id: "leads", label: "Generate enquiries" }, { id: "sales", label: "Drive sales" }, { id: "engagement", label: "Grow my community" }];

async function requestCampaign(path: string, method = "GET", body?: unknown): Promise<CampaignDTO> {
  const response = await fetch(path, { method, credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401) throw new Error("Sign in to save and manage your campaigns.");
    if (response.status === 409) throw new Error("This campaign changed in another window. Copy any unsaved text, then reload this page to edit the latest version.");
    throw new Error(result?.message || "We couldn't save this campaign. Check your connection and try again.");
  }
  return result.campaign;
}

export function CampaignBuilder({ assistantMode = "disabled", aiAvailable = false }: { assistantMode?: "mock" | "openai" | "llm-gw" | "disabled"; aiAvailable?: boolean }) {
  const demoEnabled = assistantMode === "mock";
  const assistController = useRef<AbortController | null>(null);
  const assistEpoch = useRef(0);
  const invalidateAssistance = useCallback(() => {
    assistEpoch.current += 1;
    assistController.current?.abort();
    assistController.current = null;
  }, []);
  const router = useRouter(); const params = useSearchParams();
  const requestedId = params.get("id");
  const assistContext = useRef(requestedId);
  assistContext.current = requestedId;
  const [campaign, setCampaign] = useState<CampaignBuilderState>(emptyCampaign);
  const [saved, setSaved] = useState<{ id: string; version: number } | null>(null);
  const [step, setStep] = useState(0); const [furthest, setFurthest] = useState(0);
  const [loading, setLoading] = useState(Boolean(requestedId)); const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false); const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState(""); const heading = useRef<HTMLHeadingElement>(null);
  const loadedId = useRef<string | null>(null); const initialized = useRef(false);
  const savePending = useRef<Promise<CampaignDTO | null> | null>(null);
  const leaveRef = useRef<(href: string) => void>(() => {});
  const guard = useCallback((href: string) => leaveRef.current(href), []);
  useWorkspaceNavigationGuard(dirty || saving ? guard : undefined);
  const [assisting, setAssisting] = useState(false);
  const [suggestion, setSuggestion] = useState<{ brief?: string; creatives?: CampaignCreative[]; message: string } | null>(null);
  const queryStep = Math.max(0, Math.min(6, Number(params.get("step")) || 0));
  const resetCampaign = useCallback(() => { invalidateAssistance(); setAssisting(false); loadedId.current = null; setSaved(null); setCampaign({ ...emptyCampaign, plan: { ...emptyCampaign.plan, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" } }); setDirty(false); setStep(0); setFurthest(0); setError(null); setNotice(""); setSuggestion(null); }, [invalidateAssistance]);

  // Search-parameter navigation can reuse this component for another campaign.
  // Both brand lookups and generated previews must remain bound to their origin.
  useEffect(() => {
    invalidateAssistance();
    setAssisting(false);
    setSuggestion(null);
    return invalidateAssistance;
  }, [requestedId, invalidateAssistance]);

  useEffect(() => {
    if (!initialized.current) { initialized.current = true; setCampaign((value) => ({ ...value, plan: { ...value.plan, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" } })); }
    if (!requestedId) { if (loadedId.current) resetCampaign(); return; }
    if (requestedId === loadedId.current) return;
    let current = true; setLoading(true); setSaved(null); setError(null); setSuggestion(null);
    requestCampaign(`/api/workspace/campaigns/${encodeURIComponent(requestedId)}`).then((result) => {
      if (!current) return;
      loadedId.current = result.id;
      setCampaign(campaignFromDTO(result)); setSaved({ id: result.id, version: result.version }); setDirty(false); setFurthest(6); setStep(Number.isInteger(queryStep) ? queryStep : 0);
    }).catch((failure) => { if (current) setError(failure instanceof Error ? failure.message : "This campaign could not be loaded."); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [requestedId, queryStep, resetCampaign]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  leaveRef.current = (href) => { void (async () => { if ((dirty || saving) && !await save()) return; if (href === "/campaigns/create") resetCampaign(); router.push(href); })(); };
  function update(patch: Partial<CampaignBuilderState>) { setCampaign((current) => ({ ...current, ...patch })); setDirty(true); setNotice(""); setError(null); setSuggestion(null); }
  function updatePlan(key: string, value: string) { update({ plan: { ...campaign.plan, [key]: value } }); }
  function moveTo(next: number) { setStep(next); setFurthest((current) => Math.max(current, next)); setError(null); setSuggestion(null); if (loadedId.current) window.history.replaceState(window.history.state, "", `/campaigns/create?id=${encodeURIComponent(loadedId.current)}&step=${next}`); window.setTimeout(() => heading.current?.focus(), 0); }
  function save(ready = false): Promise<CampaignDTO | null> {
    if (savePending.current) return savePending.current;
    setSaving(true); setError(null);
    const pending = (async () => { try {
      const body = { type: campaign.type, name: campaign.name.trim() || `${campaignTypes.find((item) => item.type === campaign.type)?.label} draft`, websiteUrl: campaign.websiteUrl.trim(), brief: campaign.brief, goal: campaign.goal, audience: campaign.audience, platforms: campaign.platforms, plan: campaign.plan, creatives: campaign.creatives, status: ready ? "READY" : "DRAFT", ...(saved ? { version: saved.version } : {}) };
      const result = await requestCampaign(saved ? `/api/workspace/campaigns/${encodeURIComponent(saved.id)}` : "/api/workspace/campaigns", saved ? "PATCH" : "POST", body);
      loadedId.current = result.id; setSaved({ id: result.id, version: result.version }); setDirty(false); setNotice("Saved to your campaign library.");
      if (!saved) window.history.replaceState(window.history.state, "", `/campaigns/create?id=${encodeURIComponent(result.id)}&step=${step}`);
      return result;
    } catch (failure) { setError(failure instanceof Error ? failure.message : "We couldn't save your campaign. Try again."); return null; }
    finally { setSaving(false); savePending.current = null; } })();
    savePending.current = pending; return pending;
  }
  async function next() {
    const invalid = campaignStepError(campaign, step);
    if (invalid) { setError(invalid); return; }
    if (await save()) moveTo(step + 1);
  }
  async function finish() {
    for (let index = 1; index <= 5; index++) { const invalid = campaignStepError(campaign, index); if (invalid) { moveTo(index); setError(invalid); return; } }
    const result = await save(true); if (result) router.push(`/campaigns/${encodeURIComponent(result.id)}`);
  }
  function toggleChannel(id: string) {
    const platforms = campaign.platforms.includes(id) ? campaign.platforms.filter((platform) => platform !== id) : [...campaign.platforms, id];
    update(syncCampaignCreatives({ ...campaign, platforms }));
  }
  function updateCreative(platform: string, patch: Partial<CampaignCreative>) { update({ creatives: campaign.creatives.map((creative) => creative.platform === platform ? { ...creative, ...patch } : creative) }); }
  function beginAssistance(timeoutMs: number) {
    invalidateAssistance();
    const epoch = assistEpoch.current;
    const controller = new AbortController();
    assistController.current = controller;
    setAssisting(true); setSuggestion(null); setError(null);
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    return { epoch, context: requestedId, controller, timer };
  }
  function isCurrentAssistance(operation: ReturnType<typeof beginAssistance>) {
    return assistEpoch.current === operation.epoch && assistContext.current === operation.context;
  }
  function endAssistance(operation: ReturnType<typeof beginAssistance>) {
    window.clearTimeout(operation.timer);
    // An old request may settle after a replacement operation has already begun.
    if (!isCurrentAssistance(operation)) return;
    assistController.current = null;
    setAssisting(false);
  }
  async function applyBrandGuidelines() {
    const operation = beginAssistance(15000);
    try {
      const response = await fetch("/api/workspace/brand", { credentials: "same-origin", cache: "no-store", signal: operation.controller.signal });
      if (!response.ok) throw new Error("We couldn't load your brand guidelines. Save them in Content Studio first.");
      const { brand } = await response.json() as { brand: BrandDTO };
      if (!isCurrentAssistance(operation)) return;
      if (operation.controller.signal.aborted) throw new Error("Brand lookup timed out.");
      const guidance = [brand.name && `Brand: ${brand.name}`, brand.voice && `Voice: ${brand.voice}`, brand.rules && `Rules: ${brand.rules}`].filter(Boolean).join("\n");
      if (!guidance) throw new Error("Add your brand voice or rules in Content Studio, then return to use them here.");
      const brief = [campaign.brief, guidance].filter(Boolean).join("\n\n");
      if (brief.length > 5000) throw new Error("These brand guidelines are longer than the brief limit. Add the most relevant rules manually.");
      update({ brief, ...(!campaign.websiteUrl && brand.websiteUrl ? { websiteUrl: brand.websiteUrl } : {}), ...(!campaign.audience && brand.audience ? { audience: brand.audience } : {}) });
      setNotice("Brand guidelines added. Review and edit them for this campaign.");
    } catch (failure) {
      if (isCurrentAssistance(operation)) setError(operation.controller.signal.aborted
        ? "The brand lookup timed out. Your campaign is unchanged. Try again."
        : failure instanceof Error ? failure.message : "Brand guidelines could not be loaded.");
    } finally { endAssistance(operation); }
  }
  async function assist(action: "BRIEF" | "CREATIVES") {
    const operation = beginAssistance(assistantMode === "llm-gw" ? 125000 : 50000);
    try {
      const response = await fetch("/api/workspace/assist", { method: "POST", credentials: "same-origin", signal: operation.controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, campaign }) });
      const result = await response.json().catch(() => null);
      if (!isCurrentAssistance(operation)) return;
      if (operation.controller.signal.aborted) throw new Error("Suggestion request timed out.");
      if (!response.ok) throw new Error(result?.message || "Suggestions are unavailable. Your original content is unchanged.");
      if (result?.mode !== assistantMode) throw new Error("This suggestion could not be verified. Your original content is unchanged.");
      setSuggestion({ brief: result.brief, creatives: result.creatives, message: result.message });
    } catch (failure) {
      if (isCurrentAssistance(operation)) setError(operation.controller.signal.aborted
        ? "The suggestion request timed out. Your original content is unchanged. Try again."
        : failure instanceof Error ? failure.message : "Suggestions could not be prepared.");
    } finally { endAssistance(operation); }
  }
  const typeLabel = campaignTypes.find((item) => item.type === campaign.type)?.label;

  return <div className={styles.builder} data-testid="unified-campaign-builder">
    <header className={styles.header}><div><p className={styles.eyebrow}>Campaigns / {saved ? "Edit campaign" : "New campaign"}</p><h1>A clear plan. Better content.</h1><p className={styles.muted}>Start with your brief. Build a campaign around the right channels.</p></div><div className={styles.actions}><Link href="/campaigns" className={styles.textLink}>Campaign library</Link><button className={styles.secondary} onClick={() => void save()} disabled={saving || loading || assisting}>{saving ? "Saving…" : "Save draft"}</button></div></header>
    {loading ? <div role="status" aria-label="Loading campaign" className={styles.loading} /> : requestedId && !saved && error ? <div className={styles.error} role="alert">{error} <Link href="/campaigns">Return to campaigns</Link></div> : <>
      <nav aria-label="Campaign creation progress"><ol className={styles.steps}>{steps.map((label, index) => <li key={label} aria-current={step === index ? "step" : undefined}><button disabled={index > furthest || saving || assisting} onClick={() => moveTo(index)} aria-label={`Step ${index + 1}: ${label}${index < step ? ", completed" : ""}`}><span className={styles.stepNumber}>{String(index + 1).padStart(2, "0")}</span>{label}</button></li>)}</ol></nav>
      <div className={styles.layout}><section className={styles.panel} aria-labelledby="builder-step-heading"><p className={styles.eyebrow}>Step {step + 1} of {steps.length}</p>
        <h2 id="builder-step-heading" ref={heading} tabIndex={-1}>{["What are we creating?", "Tell us about your campaign", "Who should this reach?", "Choose your channels", campaign.type === "ADS" ? "Set your budget and timing" : "Plan your publishing rhythm", "Shape the content for each channel", "Review your campaign"][step]}</h2>
        <p className={styles.muted}>{["Choose the campaign type. Your channels and content options adapt to it.", "Your website and a detailed brief give the campaign its context.", "Give the campaign one clear objective and a specific audience.", "Your channel choices guide formats and creative requirements.", campaign.type === "ADS" ? "Record your spending plan. Saving a budget does not authorize ad spending." : "Set the overall plan. Individual posts are scheduled after content review.", "Save an editable starting point. Media and channel approvals are completed before publishing.", "Save the plan, then prepare and approve the content for delivery."][step]}</p>
        {assisting && <p role="status" className={`${styles.note} my-4`}>Preparing your suggestions…</p>}
        {error && <div role="alert" className={styles.error}>{error}{error.startsWith("Sign in") && <> <Link href="/sign-in?returnTo=/campaigns/create">Sign in</Link></>}</div>}
        <fieldset disabled={saving || assisting} className="min-w-0">
          <legend className="sr-only">{steps[step]}</legend>
          {step === 0 && <div className={styles.choices}>{campaignTypes.map((item) => <label className={styles.choice} data-selected={campaign.type === item.type} key={item.type}><input type="radio" name="campaign-type" value={item.type} checked={campaign.type === item.type} onChange={() => { update(changeCampaignType(campaign, item.type)); setFurthest(0); }} /><div><strong>{item.label}</strong><span>{item.description}</span></div></label>)}</div>}
          {step === 1 && <div className={styles.fields}>
            <label className={styles.field}>Campaign name<input className={styles.input} value={campaign.name} maxLength={120} placeholder="Autumn collection launch" onChange={(event) => update({ name: event.target.value })} autoComplete="off" /></label>
            <label className={styles.field}>Website or product URL<input className={styles.input} type="url" value={campaign.websiteUrl} maxLength={2000} placeholder="https://yourbrand.com/collection" onChange={(event) => update({ websiteUrl: event.target.value })} /><small>This address is saved as context and a destination. We do not automatically crawl it.</small></label>
            <label className={styles.field}>Campaign brief<textarea className={styles.input} rows={7} value={campaign.brief} maxLength={5000} placeholder="Describe your product, offer, main message, proof points and what you want people to do. Include tone of voice and anything to avoid." onChange={(event) => update({ brief: event.target.value })} /><small>Be specific about the offer and the facts your content should communicate.</small></label>
            <div><div className={styles.actions}>{aiAvailable ? <button className={styles.secondary} onClick={() => void assist("BRIEF")} disabled={!campaign.brief.trim()}>Enhance brief</button> : <button className={styles.secondary} onClick={() => setSuggestion({ brief: structureCampaignBrief(campaign.brief).slice(0, 5000), message: "Editable writing prompts around your original text. AI enhancement is not connected yet." })} disabled={!campaign.brief.trim() || campaign.brief.includes("Offer and proof\n")}>Structure my brief</button>}<button className={styles.secondary} onClick={() => void applyBrandGuidelines()}>Use brand guidelines</button></div><p className={`${styles.muted} mt-2`}>{demoEnabled ? "Demo suggestions use your brief and campaign context. Review before applying; no live AI service is called." : aiAvailable ? "AI uses your brief, audience, channels and saved brand rules. Review the result before applying." : "AI is unavailable until an administrator configures it. You can structure your brief locally and keep working."}</p></div>
            {suggestion?.brief && <section className={styles.preview} aria-label="Brief enhancement preview"><p className={styles.eyebrow}>{demoEnabled ? "Demo suggestion" : aiAvailable ? "AI suggestion" : "Brief structure"}</p><h3>Review the enhanced brief</h3><p className={styles.muted}>{suggestion.message}</p><pre>{suggestion.brief}</pre><div className={styles.actions}><button className={styles.button} onClick={() => { update({ brief: suggestion.brief! }); setNotice("Enhanced brief applied. Review the text before saving."); }}>Apply enhanced brief</button><button className={styles.secondary} onClick={() => setSuggestion(null)}>Keep original</button></div></section>}
          </div>}
          {step === 2 && <div className={styles.fields}><label className={styles.field}>Primary objective<select className={styles.input} value={campaign.goal} onChange={(event) => update({ goal: event.target.value })}>{goals.map((goal) => <option value={goal.id} key={goal.id}>{goal.label}</option>)}</select></label><label className={styles.field}>Audience description<textarea className={styles.input} rows={5} value={campaign.audience} maxLength={2000} placeholder="Who are they? What do they need, where are they based and why would this offer matter to them?" onChange={(event) => update({ audience: event.target.value })} /><small>Use a useful description rather than a broad demographic alone.</small></label></div>}
          {step === 3 && <><div className={styles.choices}>{campaignChannels[campaign.type].map((channel) => <label key={channel.id} className={styles.choice} data-selected={campaign.platforms.includes(channel.id)}><input type="checkbox" checked={campaign.platforms.includes(channel.id)} onChange={() => toggleChannel(channel.id)} /><div><strong>{channel.label}</strong><span>{channel.description}</span></div></label>)}</div><div className="mt-5"><p className={styles.note}>{campaign.type === "EMAIL" || campaign.type === "BLOG" ? "This campaign supports drafting. Connect a delivery or publishing service in a future release before sending it." : "You can plan content before connecting accounts. A verified destination is required before delivery."} {campaign.type === "SOCIAL" || campaign.type === "ADS" ? <Link className={styles.textLink} href="/connections" target="_blank" rel="noopener noreferrer">Manage channels ↗</Link> : null}</p></div></>}
          {step === 4 && <div className={styles.fields}>
            {campaign.type === "ADS" && <div className={styles.twoColumns}><label className={styles.field}>Total planned budget<input className={styles.input} type="number" min="0.01" step="0.01" value={String(campaign.plan.totalBudget || "")} onChange={(event) => updatePlan("totalBudget", event.target.value)} placeholder="1500.00" /></label><label className={styles.field}>Currency<select className={styles.input} value={String(campaign.plan.currency || "USD")} onChange={(event) => updatePlan("currency", event.target.value)}><option>USD</option><option>GBP</option><option>EUR</option><option>CAD</option><option>AUD</option></select></label></div>}
            <div className={styles.twoColumns}><label className={styles.field}>Planned start date <span className={styles.muted}>(optional)</span><input className={styles.input} type="date" value={String(campaign.plan.startDate || "")} onChange={(event) => updatePlan("startDate", event.target.value)} /></label><label className={styles.field}>Planned end date <span className={styles.muted}>(optional)</span><input className={styles.input} type="date" value={String(campaign.plan.endDate || "")} min={String(campaign.plan.startDate || "")} onChange={(event) => updatePlan("endDate", event.target.value)} /></label></div>
            {campaign.type === "SOCIAL" && <><label className={styles.field}>Planned posts per week<input className={styles.input} type="number" min="1" max="21" step="1" value={String(campaign.plan.cadence || "")} onChange={(event) => updatePlan("cadence", event.target.value)} /><small>This records the intended cadence. Create and approve individual posts to fill the schedule.</small></label><div className={styles.note}>After you approve and schedule each post, the publishing worker delivers it automatically. This plan does not generate or approve posts on your behalf.</div></>}
            {campaign.type !== "ADS" && <label className={styles.field}>Planning notes <span className={styles.muted}>(optional)</span><textarea className={styles.input} rows={3} maxLength={1000} value={String(campaign.plan.notes || "")} onChange={(event) => updatePlan("notes", event.target.value)} placeholder="Key dates, content themes or review milestones" /></label>}
          </div>}
          {step === 5 && <div className={styles.fields}><div><button className={styles.secondary} disabled={!aiAvailable || !campaign.platforms.length} onClick={() => void assist("CREATIVES")}>Generate drafts</button><p className={`${styles.muted} mt-2`}>{demoEnabled ? "Demo suggestions are tailored to your brief and selected channels. Review the preview before replacing your drafts." : aiAvailable ? "AI drafts copy, video scripts and visual directions using your brand rules. Review before applying. Finished images and videos are added in the post composer." : "AI is unavailable until an administrator configures it. Write and save your content below."}</p></div>{suggestion?.creatives && <section className={styles.preview} aria-label="Generated drafts preview"><p className={styles.eyebrow}>{demoEnabled ? "Demo suggestions" : "AI suggestions"}</p><h3>Review generated drafts</h3><p className={styles.muted}>{suggestion.message}</p>{suggestion.creatives.map((creative) => <div key={creative.platform}><h4>{campaignChannels[campaign.type].find((channel) => channel.id === creative.platform)?.label}</h4><pre>{[creative.title, creative.body, creative.cta, creative.script && `Video script: ${creative.script}`, creative.visualBrief && `Visual direction: ${creative.visualBrief}`].filter(Boolean).join("\n\n")}</pre></div>)}<p className={styles.muted}>Applying replaces the content drafts below. Your original drafts stay unchanged until you apply.</p><div className={`${styles.actions} mt-3`}><button className={styles.button} onClick={() => { update({ creatives: suggestion.creatives! }); setNotice("Generated drafts applied. Review each channel before saving."); }}>Apply generated drafts</button><button className={styles.secondary} onClick={() => setSuggestion(null)}>Keep original drafts</button></div></section>}{campaign.creatives.map((creative) => { const channel = campaignChannels[campaign.type].find((item) => item.id === creative.platform); return <section key={creative.platform} className={styles.creative}><div className={styles.creativeHeader}><h3>{channel?.label}</h3><span className={styles.format}>{creative.format.replaceAll("_", " ").toLowerCase()}</span></div><div className="grid gap-4"><label className={styles.field}>{campaign.type === "EMAIL" ? "Subject line" : campaign.type === "BLOG" ? "Article title" : creative.platform === "GOOGLE" ? "Ad headline" : "Title or opening hook"}<input className={styles.input} maxLength={200} value={creative.title} onChange={(event) => updateCreative(creative.platform, { title: event.target.value })} /></label><label className={styles.field}>{campaign.type === "EMAIL" ? "Email body" : campaign.type === "BLOG" ? "Article draft" : creative.format === "SHORT_VIDEO" ? "Published caption / description" : "Copy / caption"}<textarea className={styles.input} rows={campaign.type === "BLOG" ? 10 : 5} maxLength={campaign.type === "BLOG" ? 12000 : 2000} value={creative.body} onChange={(event) => updateCreative(creative.platform, { body: event.target.value })} placeholder={creative.format === "SHORT_VIDEO" ? "Write the public caption. Keep production notes in the video script below." : "Draft the message for this channel, using your campaign brief."} /><small>{channel?.description}. This is planning copy; channel limits are checked in the delivery workflow.</small></label><label className={styles.field}>Call to action<input className={styles.input} maxLength={200} value={creative.cta} placeholder="Explore the collection" onChange={(event) => updateCreative(creative.platform, { cta: event.target.value })} /><small>Include this action in the publishable copy where appropriate.</small></label>{(creative.format === "SHORT_VIDEO" || creative.script) && <label className={styles.field}>Video script<textarea className={styles.input} rows={5} maxLength={1000} value={creative.script ?? ""} onChange={event => updateCreative(creative.platform, {script:event.target.value})}/><small>Production notes only. Upload the finished video before approval.</small></label>}{(["SHORT_VIDEO","IMAGE"].includes(creative.format) || creative.visualBrief) && <label className={styles.field}>Visual direction<textarea className={styles.input} rows={3} maxLength={400} value={creative.visualBrief ?? ""} onChange={event => updateCreative(creative.platform, {visualBrief:event.target.value})}/></label>}</div></section>; })}</div>}
          {step === 6 && <div className={styles.review}><section><h3>{campaign.name}</h3><p>{typeLabel} · {goals.find((goal) => goal.id === campaign.goal)?.label}</p><p>{campaign.websiteUrl}</p><p>{campaign.brief}</p></section><section><h3>Audience and channels</h3><p>{campaign.audience}</p><p>{campaign.platforms.map((id) => campaignChannels[campaign.type].find((channel) => channel.id === id)?.label).join(" · ")}</p></section><section><h3>Campaign plan</h3><p>{campaign.type === "ADS" ? `${campaign.plan.currency || "USD"} ${campaign.plan.totalBudget || "—"} planned budget` : campaign.type === "SOCIAL" ? `${campaign.plan.cadence} planned posts per week` : "Content preparation"}</p><p>{String(campaign.plan.startDate || "Start date to be decided")} {campaign.plan.endDate ? `→ ${campaign.plan.endDate}` : ""}</p></section><section><h3>Content drafts</h3>{campaign.creatives.map((creative) => <p key={creative.platform}><strong>{campaignChannels[campaign.type].find((channel) => channel.id === creative.platform)?.label}</strong><br />{creative.title}{creative.title ? "\n" : ""}{creative.body}{creative.cta ? `\n${creative.cta}` : ""}</p>)}</section><CampaignExecution type={campaign.type} platforms={campaign.platforms} /></div>}
        </fieldset>
        <footer className={styles.footer}><div><button className={styles.secondary} disabled={step === 0 || saving || assisting} onClick={() => moveTo(step - 1)}>Back</button></div><div className="text-right"><button className={styles.button} disabled={saving || assisting} onClick={() => void (step < 6 ? next() : finish())}>{saving ? "Saving…" : step === 6 ? "Save campaign" : "Save & continue"}</button><p className={`${styles.saveStatus} mt-2`} role="status" aria-live="polite">{notice || (dirty ? "Unsaved changes" : saved ? "All changes saved" : "Your draft will be saved as you go")}</p></div></footer>
      </section><aside className={styles.aside} aria-label="Campaign summary"><h2>Your campaign at a glance</h2><dl><div><dt>Campaign type</dt><dd>{typeLabel}</dd></div><div><dt>Working title</dt><dd>{campaign.name || "Untitled campaign"}</dd></div><div><dt>Primary objective</dt><dd>{goals.find((goal) => goal.id === campaign.goal)?.label}</dd></div><div><dt>Channels</dt><dd>{campaign.platforms.length ? campaign.platforms.map((id) => campaignChannels[campaign.type].find((channel) => channel.id === id)?.label).join(", ") : "Choose in step 4"}</dd></div></dl><p className={`${styles.note} mt-8`}>A strong brief is specific about the audience, the offer and the action you want people to take.</p></aside></div>
    </>}
  </div>;
}
