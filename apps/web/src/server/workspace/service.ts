import type { Prisma, PrismaClient, WorkspaceCampaign, BrandKit } from "../../generated/prisma/client";
import type { CustomerPrincipal } from "../auth/customerAuth";
import { fail } from "../security/errors";
import type { BrandDTO, CampaignDTO, CampaignInput, CampaignType, WorkspaceSummary, WorkspaceAssistance } from "./types";

import { assistantSettings, CampaignAiAssistant } from "./assistant";
import { reserveAiRequest } from "./aiQuota";

const channels: Record<CampaignType, readonly string[]> = {
  SOCIAL: ["YOUTUBE", "FACEBOOK", "INSTAGRAM", "TIKTOK", "LINKEDIN", "X"], ADS: ["GOOGLE", "META"], EMAIL: ["EMAIL"], BLOG: ["BLOG"],
};
const emptyCampaign: CampaignInput = { type: "SOCIAL", name: "Untitled campaign", websiteUrl: "", brief: "", goal: "", audience: "", platforms: [], plan: {}, creatives: [], socialPostIds: [], status: "DRAFT" };
const emptyBrand: BrandDTO = { version: 0, name: "", websiteUrl: "", voice: "", audience: "", colors: [], rules: "", logoUrl: "", updatedAt: null };
function invalid(message: string): never { fail("INVALID_BODY", 400, message); }
function fields(body: Record<string, unknown>, allowed: string[]) { if (Object.keys(body).some(key => !allowed.includes(key))) invalid("Supply only supported workspace fields."); }
function text(value: unknown, label: string, max: number) { if (typeof value !== "string" || value.length > max) invalid(`${label} must be text up to ${max} characters.`); return value.trim(); }
function url(value: unknown, label: string) {
  const result = text(value, label, 2048);
  if (!result) return result;
  try { const parsed = new URL(result); if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(); }
  catch { invalid(`${label} must be an HTTP or HTTPS URL without credentials.`); }
  return result;
}
function strings(value: unknown, label: string, max: number) {
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== "string" || !item || item.length > 128) || new Set(value).size !== value.length) invalid(`${label} must be a list of up to ${max} unique values.`);
  return value as string[];
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function json(value: unknown) {
  try { if (JSON.stringify(value).length > 24000) invalid("Campaign content is too large."); }
  catch { invalid("Campaign content must be JSON."); }
}
function revision(value: unknown) { if (!Number.isSafeInteger(value) || (value as number) < 0) invalid("Supply the current version."); return value as number; }
function campaignInput(body: Record<string, unknown>, current = emptyCampaign): CampaignInput {
  fields(body, [...Object.keys(emptyCampaign), "version"]);
  const value = { ...current, ...body };
  if (typeof value.type !== "string" || !Object.hasOwn(channels, value.type)) invalid("Choose a supported campaign type.");
  const type = value.type as CampaignType;
  const platforms = strings(value.platforms, "Platforms", 6);
  if (platforms.some(platform => !channels[type].includes(platform))) invalid("Choose platforms supported by this campaign type.");
  if (!["DRAFT", "READY", "ARCHIVED"].includes(value.status)) invalid("Campaign status must be DRAFT, READY, or ARCHIVED. Delivery status is managed by the publishing service.");
  if (!object(value.plan) || !Array.isArray(value.creatives) || value.creatives.length > 50 || !value.creatives.every(object)) invalid("Supply a plan object and a list of creative objects.");
  json(value.plan); json(value.creatives);
  const result: CampaignInput = { type, name: text(value.name, "Name", 200), websiteUrl: url(value.websiteUrl, "Website"), brief: text(value.brief, "Brief", 10000), goal: text(value.goal, "Goal", 2000), audience: text(value.audience, "Audience", 4000), platforms, plan: value.plan as CampaignInput["plan"], creatives: value.creatives as CampaignInput["creatives"], socialPostIds: strings(value.socialPostIds, "Social posts", 100), status: value.status };
  if (!result.name) invalid("Give the campaign a name.");
  if (result.socialPostIds.length && type !== "SOCIAL") invalid("Only social campaigns can link social posts.");
  if (result.status === "READY" && (!result.websiteUrl || !result.brief || !platforms.length)) invalid("Add a website, brief, and platforms before marking the plan ready.");
  return result;
}
function execution(type: string): CampaignDTO["execution"] {
  if (type === "SOCIAL") return { mode: "SOCIAL_APPROVAL", message: "Review, approve, and schedule linked posts in Social Marketing. The publishing worker then delivers the approved posts." };
  if (type === "ADS") return { mode: "ADS_API", message: "Campaign saved for Google and Meta account readiness. Ad campaign creation and spending are not enabled yet." };
  return { mode: "DRAFT_ONLY", message: "Drafting is available. Publishing requires a delivery integration." };
}
function brandDto(row: BrandKit | null): BrandDTO { return row ? { name: row.name, websiteUrl: row.websiteUrl, voice: row.voice, audience: row.audience, colors: row.colors as string[], rules: row.rules, logoUrl: row.logoUrl, version: row.version, updatedAt: row.updatedAt.toISOString() } : { ...emptyBrand }; }

export class WorkspaceService {
  constructor(private readonly db: PrismaClient, private readonly assistantMode = assistantSettings().mode, private readonly assistant = new CampaignAiAssistant({mode: assistantMode === "llm-gw" ? "llm-gw" : "openai"})) {}
  async assist(principal: CustomerPrincipal, body: Record<string, unknown>): Promise<WorkspaceAssistance> {
    if (!["mock", "openai", "llm-gw"].includes(this.assistantMode ?? "")) fail("ASSISTANT_UNAVAILABLE", 503, "AI assistance is not configured. You can write and edit your campaign manually.");
    fields(body, ["action", "campaign"]);
    if (!["BRIEF", "CREATIVES"].includes(body.action as string) || !object(body.campaign)) invalid("Choose BRIEF or CREATIVES and supply campaign context.");
    fields(body.campaign, ["type", "name", "websiteUrl", "brief", "goal", "audience", "platforms", "plan", "creatives"]);
    for (const key of ["type", "name", "websiteUrl", "brief", "goal", "audience", "platforms"]) if (!(key in body.campaign)) invalid("Supply the campaign type, name, website, brief, goal, audience, and platforms.");
    const campaign = campaignInput(body.campaign);
    if (!campaign.brief) invalid("Write a campaign brief before requesting suggestions.");
    if (body.action === "CREATIVES" && !campaign.platforms.length) invalid("Choose at least one channel before requesting creative suggestions.");
    if (this.assistantMode === "openai" || this.assistantMode === "llm-gw") {
      if (!this.assistant.configured()) fail("ASSISTANT_UNAVAILABLE", 503, "AI assistance needs a server API key. You can still write and save your campaign manually.");
      const brand = await this.brand(principal);
      await reserveAiRequest(this.db, principal.userId);
      return this.assistant.generate(body.action as "BRIEF" | "CREATIVES", campaign, brand);
    }
    const message = "Demo suggestions use your supplied text only. They are simulated, editable drafts; no live AI or website research was used.";
    if (body.action === "BRIEF") {
      const brief = [campaign.brief, `Campaign: ${campaign.name}`, campaign.websiteUrl && `Website: ${campaign.websiteUrl}`, campaign.goal && `Goal: ${campaign.goal}`, campaign.audience && `Audience: ${campaign.audience}`].filter(Boolean).join("\n\n");
      if (brief.length > 10000) invalid("Shorten the brief before adding campaign context; the result must fit within 10000 characters.");
      return { mode: "mock", message, brief };
    }
    if (!campaign.platforms.length) invalid("Choose at least one channel before requesting creative suggestions.");
    const formats: Record<string, string> = { YOUTUBE: "SHORT_VIDEO", FACEBOOK: "IMAGE", INSTAGRAM: "SHORT_VIDEO", TIKTOK: "SHORT_VIDEO", LINKEDIN: "TEXT", X: "TEXT", GOOGLE: "SEARCH", META: "IMAGE", EMAIL: "EMAIL", BLOG: "ARTICLE" };
    const clip = (value: string, length: number) => Array.from(value).slice(0, length).join("");
    return { mode: "mock", message, creatives: campaign.platforms.map(platform => ({
      platform, format: formats[platform], title: clip(campaign.name, platform === "GOOGLE" ? 30 : platform === "YOUTUBE" ? 100 : 200),
      body: clip(campaign.brief, platform === "GOOGLE" ? 90 : platform === "X" ? 280 : platform === "BLOG" ? 10000 : 2000),
      cta: campaign.websiteUrl ? "Learn more" : "",
    })) };
  }
  private async dto(row: WorkspaceCampaign): Promise<CampaignDTO> {
    const linkedPosts = await this.db.socialPost.findMany({ where: { ownerId: row.ownerId, id: { in: row.socialPostIds as string[] } }, select: { id: true, title: true, status: true, updatedAt: true } });
    return { id: row.id, type: row.type as CampaignType, name: row.name, websiteUrl: row.websiteUrl, brief: row.brief, goal: row.goal, audience: row.audience, platforms: row.platforms as string[], plan: row.plan as CampaignInput["plan"], creatives: row.creatives as CampaignInput["creatives"], socialPostIds: linkedPosts.map(post => post.id), status: row.status as CampaignInput["status"], version: row.version, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), linkedPosts: linkedPosts.map(post => ({ ...post, updatedAt: post.updatedAt.toISOString() })), execution: execution(row.type) };
  }
  async list(principal: CustomerPrincipal) {
    return Promise.all((await this.db.workspaceCampaign.findMany({ where: { ownerId: principal.userId }, orderBy: { updatedAt: "desc" } })).map(row => this.dto(row)));
  }
  private async owned(principal: CustomerPrincipal, id: string) {
    const row = await this.db.workspaceCampaign.findFirst({ where: { id, ownerId: principal.userId } });
    if (!row) fail("NOT_FOUND", 404, "Campaign not found.");
    return row;
  }
  async get(principal: CustomerPrincipal, id: string) { return this.dto(await this.owned(principal, id)); }
  private async checkPosts(principal: CustomerPrincipal, ids: string[], tx: Prisma.TransactionClient) {
    if (ids.length && await tx.socialPost.count({ where: { ownerId: principal.userId, id: { in: ids } } }) !== ids.length) fail("NOT_FOUND", 404, "A selected social post is unavailable.");
  }
  async create(principal: CustomerPrincipal, body: Record<string, unknown>) {
    if ("version" in body) invalid("New campaigns do not have a version yet.");
    const data = campaignInput(body);
    const row = await this.db.$transaction(async tx => { await this.checkPosts(principal, data.socialPostIds, tx); return tx.workspaceCampaign.create({ data: { ...data, ownerId: principal.userId } }); });
    return this.dto(row);
  }
  async update(principal: CustomerPrincipal, id: string, body: Record<string, unknown>) {
    const version = revision(body.version);
    const row = await this.owned(principal, id);
    const data = campaignInput(body, { ...row, type: row.type as CampaignType, platforms: row.platforms as string[], plan: row.plan as CampaignInput["plan"], creatives: row.creatives as CampaignInput["creatives"], socialPostIds: row.socialPostIds as string[], status: row.status as CampaignInput["status"] });
    const changed = await this.db.$transaction(async tx => {
      await this.checkPosts(principal, data.socialPostIds, tx);
      const result = await tx.workspaceCampaign.updateMany({ where: { id, ownerId: principal.userId, version }, data: { ...data, version: { increment: 1 } } });
      if (!result.count) fail("REVISION_CONFLICT", 409, "This campaign changed in another window. Reload before saving.");
      return tx.workspaceCampaign.findUniqueOrThrow({ where: { id } });
    });
    return this.dto(changed);
  }
  async brand(principal: CustomerPrincipal) { return brandDto(await this.db.brandKit.findUnique({ where: { ownerId: principal.userId } })); }
  async updateBrand(principal: CustomerPrincipal, body: Record<string, unknown>) {
    fields(body, ["version", "name", "websiteUrl", "voice", "audience", "colors", "rules", "logoUrl"]);
    const version = revision(body.version);
    const value = { ...await this.brand(principal), ...body };
    const colors = strings(value.colors, "Brand colors", 12);
    if (colors.some(color => !/^#[a-fA-F0-9]{6}$/.test(color))) invalid("Use six-digit hex colors, for example #426B53.");
    const data = { name: text(value.name, "Brand name", 200), websiteUrl: url(value.websiteUrl, "Website"), voice: text(value.voice, "Voice", 4000), audience: text(value.audience, "Audience", 4000), colors, rules: text(value.rules, "Rules", 10000), logoUrl: url(value.logoUrl, "Logo") };
    try {
      const changed = await this.db.$transaction(async tx => {
        if (version === 0) return tx.brandKit.create({ data: { ...data, ownerId: principal.userId } });
        const result = await tx.brandKit.updateMany({ where: { ownerId: principal.userId, version }, data: { ...data, version: { increment: 1 } } });
        if (!result.count) fail("REVISION_CONFLICT", 409, "Your brand kit changed in another window. Reload before saving.");
        return tx.brandKit.findUniqueOrThrow({ where: { ownerId: principal.userId } });
      });
      return brandDto(changed);
    } catch (error) { if ((error as { code?: string }).code === "P2002") fail("REVISION_CONFLICT", 409, "Your brand kit changed in another window. Reload before saving."); throw error; }
  }
  async summary(principal: CustomerPrincipal): Promise<WorkspaceSummary> {
    const ownerId = principal.userId;
    const [campaigns, posts, media, connections, postCounts, mediaAssets] = await Promise.all([
      this.list(principal),
      this.db.socialPost.findMany({ where: { ownerId }, orderBy: { updatedAt: "desc" }, take: 100, select: { id: true, title: true, status: true, updatedAt: true, currentRevision: true, revisions: { orderBy: { number: "desc" }, take: 1, select: { body: true } }, deliveries: { select: { id: true, status: true, dueAt: true, destination: { select: { name: true, authorization: { select: { provider: true } } } } } } } }),
      this.db.socialMediaAsset.findMany({ where: { ownerId, status: "AVAILABLE" }, orderBy: { createdAt: "desc" }, take: 100, select: { id: true, filename: true, mime: true, type: true, width: true, height: true, durationMs: true, bytes: true, createdAt: true } }),
      this.db.providerAuthorization.findMany({ where: { userId: ownerId }, select: { id: true, provider: true, capability: true, status: true, connectionMode: true, destinations: { select: { id: true, kind: true, name: true, selected: true, available: true } } } }),
      this.db.socialPost.groupBy({ by: ["status"], where: { ownerId }, _count: { _all: true } }),
      this.db.socialMediaAsset.count({ where: { ownerId, status: "AVAILABLE" } }),
    ]);
    const linkedIds = [...new Set(campaigns.flatMap(campaign => campaign.socialPostIds))];
    const activePosts = linkedIds.length ? await this.db.socialPost.findMany({
      where: { ownerId, id: { in: linkedIds }, deliveries: { some: { status: { in: ["QUEUED", "LEASED", "RETRY_WAIT"] } } } },
      select: { id: true },
    }) : [];
    const activeIds = new Set(activePosts.map(post => post.id));
    return {
      counts: { campaigns: campaigns.length, drafts: campaigns.filter(c => c.status === "DRAFT").length, ready: campaigns.filter(c => c.status === "READY").length, activeCampaigns: campaigns.filter(campaign => campaign.socialPostIds.some(id => activeIds.has(id))).length, socialPosts: postCounts.reduce((sum, row) => sum + row._count._all, 0), scheduledPosts: postCounts.find(row => row.status === "SCHEDULED")?._count._all ?? 0, publishedPosts: postCounts.find(row => row.status === "COMPLETED")?._count._all ?? 0, mediaAssets, connectedChannels: connections.filter(c => c.status === "CONNECTED").reduce((sum, c) => sum + c.destinations.filter(d => d.selected && d.available).length, 0) },
      campaigns, posts: posts.map(post => ({ id: post.id, title: post.title, status: post.status, updatedAt: post.updatedAt.toISOString(), body: post.revisions[0]?.body ?? "", deliveries: post.deliveries.map(d => ({ id: d.id, status: d.status, dueAt: d.dueAt.toISOString(), platform: d.destination.authorization.provider, destinationName: d.destination.name })) })),
      media: media.map(asset => ({ ...asset, createdAt: asset.createdAt.toISOString() })), connections, performance: null,
    };
  }
}
