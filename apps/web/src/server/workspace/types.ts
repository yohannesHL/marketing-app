export type CampaignType = "SOCIAL" | "ADS" | "EMAIL" | "BLOG";
export type CampaignStatus = "DRAFT" | "READY" | "ARCHIVED";
export type WorkspaceJson = string | number | boolean | null | WorkspaceJson[] | { [key: string]: WorkspaceJson };
export type CampaignInput = {
  type: CampaignType; name: string; websiteUrl: string; brief: string; goal: string; audience: string;
  platforms: string[]; plan: { [key: string]: WorkspaceJson }; creatives: { [key: string]: WorkspaceJson }[];
  socialPostIds: string[]; status: CampaignStatus;
};
export type CampaignDTO = CampaignInput & {
  id: string; version: number; createdAt: string; updatedAt: string;
  linkedPosts: { id: string; title: string; status: string; updatedAt: string }[];
  execution: { mode: "SOCIAL_APPROVAL" | "ADS_API" | "DRAFT_ONLY"; message: string };
};
export type BrandDTO = { version: number; name: string; websiteUrl: string; voice: string; audience: string; colors: string[]; rules: string; logoUrl: string; updatedAt: string | null };
export type WorkspaceSummary = {
  counts: { campaigns: number; drafts: number; ready: number; activeCampaigns: number; socialPosts: number; scheduledPosts: number; publishedPosts: number; mediaAssets: number; connectedChannels: number };
  campaigns: CampaignDTO[];
  posts: { id: string; title: string; status: string; updatedAt: string; body: string; deliveries: { id: string; status: string; dueAt: string; platform: string; destinationName: string | null }[] }[];
  media: { id: string; filename: string | null; mime: string; type: string; width: number; height: number; durationMs: number | null; bytes: number; createdAt: string }[];
  connections: { id: string; provider: string; capability: string; status: string; connectionMode: string; destinations: { id: string; kind: string; name: string | null; selected: boolean; available: boolean }[] }[];
  performance: null;
};

export type WorkspaceAssistance = {
  mode: "mock" | "openai" | "llm-gw";
  message: string;
  brief?: string;
  creatives?: { platform: string; title: string; body: string; cta: string; format: string; script?: string; visualBrief?: string }[];
};
