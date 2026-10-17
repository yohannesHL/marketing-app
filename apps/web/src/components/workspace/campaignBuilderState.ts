import type { CampaignDTO, CampaignType } from "../../server/workspace/types";
export type { CampaignType } from "../../server/workspace/types";
export interface CampaignCreative { platform: string; title: string; body: string; cta: string; format: string; script?: string; visualBrief?: string }
export interface CampaignBuilderState {
  type: CampaignType; name: string; websiteUrl: string; brief: string; goal: string; audience: string;
  platforms: string[]; plan: Record<string, unknown>; creatives: CampaignCreative[];
}
export const campaignTypes: { type: CampaignType; label: string; description: string; symbol: string }[] = [
  { type: "SOCIAL", label: "Social campaign", description: "Plan content, approve posts and let your publishing schedule run.", symbol: "01" },
  { type: "ADS", label: "Paid advertising", description: "Build a campaign for Google or Meta and check account readiness.", symbol: "02" },
  { type: "EMAIL", label: "Email campaign", description: "Prepare a subject line and email. Sending integration comes later.", symbol: "03" },
  { type: "BLOG", label: "Content / blog", description: "Develop an article and publishing brief for your website.", symbol: "04" },
];
export const campaignChannels: Record<CampaignType, { id: string; label: string; description: string; format: string }[]> = {
  SOCIAL: [
    { id: "YOUTUBE", label: "YouTube Shorts", description: "Vertical video, title and description", format: "SHORT_VIDEO" },
    { id: "FACEBOOK", label: "Facebook", description: "Page posts, images and short video", format: "IMAGE" },
    { id: "INSTAGRAM", label: "Instagram", description: "Images and vertical video", format: "SHORT_VIDEO" },
    { id: "TIKTOK", label: "TikTok", description: "Vertical video and caption", format: "SHORT_VIDEO" },
    { id: "LINKEDIN", label: "LinkedIn", description: "Member and organization posts", format: "TEXT" },
    { id: "X", label: "X", description: "Concise posts, images and video", format: "TEXT" },
  ],
  ADS: [
    { id: "GOOGLE", label: "Google Ads", description: "Search headline, description and destination", format: "SEARCH" },
    { id: "META", label: "Meta Ads", description: "Facebook and Instagram ad creative", format: "IMAGE" },
  ],
  EMAIL: [{ id: "EMAIL", label: "Email", description: "Subject, email body and call to action", format: "EMAIL" }],
  BLOG: [{ id: "BLOG", label: "Website / blog", description: "Article title, body and call to action", format: "ARTICLE" }],
};
export const emptyCampaign: CampaignBuilderState = {
  type: "SOCIAL", name: "", websiteUrl: "", brief: "", goal: "awareness", audience: "",
  platforms: [], plan: { currency: "USD", cadence: "3", timeZone: "UTC" }, creatives: [],
};
export function changeCampaignType(state: CampaignBuilderState, type: CampaignType): CampaignBuilderState {
  if (type === state.type) return state;
  return syncCampaignCreatives({ ...state, type, platforms: type === "EMAIL" || type === "BLOG" ? [type] : [], creatives: [],
    plan: { currency: "USD", cadence: "3", timeZone: state.plan.timeZone || "UTC" } });
}
export function campaignFromDTO(value: CampaignDTO): CampaignBuilderState {
  const text = (input: unknown) => typeof input === "string" ? input : "";
  return syncCampaignCreatives({ type: value.type, name: value.name, websiteUrl: value.websiteUrl, brief: value.brief,
    goal: value.goal || "awareness", audience: value.audience, platforms: value.platforms, plan: { ...emptyCampaign.plan, ...value.plan },
    creatives: value.creatives.map((creative) => ({ platform: text(creative.platform), title: text(creative.title), body: text(creative.body), cta: text(creative.cta), ...(typeof creative.script === "string" ? {script: creative.script} : {}), ...(typeof creative.visualBrief === "string" ? {visualBrief: creative.visualBrief} : {}), format: text(creative.format) || campaignChannels[value.type].find((channel) => channel.id === creative.platform)?.format || "TEXT" })) });
}
export function syncCampaignCreatives(state: CampaignBuilderState): CampaignBuilderState {
  return { ...state, creatives: state.platforms.map((platform) => state.creatives.find((item) => item.platform === platform)
    ?? { platform, title: "", body: "", cta: "", format: campaignChannels[state.type].find((item) => item.id === platform)?.format ?? "TEXT" }) };
}
export function validCampaignUrl(value: string): boolean {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password; }
  catch { return false; }
}
export function campaignStepError(state: CampaignBuilderState, step: number): string | null {
  if (step === 1) {
    if (!state.name.trim()) return "Give your campaign a name.";
    if (!validCampaignUrl(state.websiteUrl)) return "Enter a full website address beginning with https:// or http://, without a username or password.";
    if (state.brief.trim().length < 20) return "Add a brief of at least 20 characters to describe your offer, message and desired outcome.";
  }
  if (step === 2 && !state.audience.trim()) return "Describe who this campaign should reach.";
  if (step === 3 && !state.platforms.length) return "Choose at least one channel for this campaign.";
  if (step === 4) {
    const start = String(state.plan.startDate || ""); const end = String(state.plan.endDate || "");
    const date = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    if (start && !date(start)) return "Choose a valid start date.";
    if (end && (!date(end) || (start && end < start))) return "The end date must be on or after the start date.";
    if (state.type === "ADS" && (!Number.isFinite(Number(state.plan.totalBudget)) || Number(state.plan.totalBudget) <= 0)) return "Enter a positive total advertising budget.";
    if (state.type === "SOCIAL" && (!Number.isInteger(Number(state.plan.cadence)) || Number(state.plan.cadence) < 1 || Number(state.plan.cadence) > 21)) return "Choose between 1 and 21 planned posts per week.";
  }
  if (step === 5 && state.platforms.some((platform) => !state.creatives.find((item) => item.platform === platform)?.body.trim())) return "Add a content draft for every selected channel.";
  return null;
}
/** Deterministic writing aid: preserves the user's text and adds visible prompts, never claims AI generation. */
export function structureCampaignBrief(brief: string): string {
  return `Campaign context\n${brief.trim()}\n\nOffer and proof\nDescribe the offer and the evidence that supports it.\n\nAudience and message\nWho should this reach, and what should they remember?\n\nDesired action\nWhat should someone do next?\n\nBrand guidance\nAdd tone, key facts and claims to avoid.`;
}
