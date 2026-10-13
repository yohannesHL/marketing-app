export const campaignGoals = [
  "Product Launch",
  "Brand Awareness",
  "Lead Generation",
  "Traffic",
] as const;

export const campaignWizardSteps = [
  "Campaign Goal",
  "Audience Targeting",
  "Budget",
  "Ad Creative Generation",
  "Platform Selection",
  "Review and Launch",
] as const;

export const supportedPlatforms = [
  "Google",
  "Meta",
  "LinkedIn",
  "TikTok",
  "X",
  "Reddit",
] as const;

export const audienceBands = ["Niche", "Balanced", "Broad"] as const;

export type CampaignGoal = (typeof campaignGoals)[number];
export type CampaignWizardStepTitle = (typeof campaignWizardSteps)[number];
export type SupportedPlatform = (typeof supportedPlatforms)[number];
export type AudienceBand = (typeof audienceBands)[number];
export type TargetGender = "Any" | "Women" | "Men";

export interface GoalStrategyResponse {
  goal: CampaignGoal;
  headline: string;
  guidance: string[];
  recommendedObjective: string;
}

export interface AudienceTargetingInput {
  location: string;
  ageRange: string;
  gender: TargetGender;
  interests: string;
  industry: string;
  jobTitles: string;
  customAudienceFileName?: string | null;
}

export interface AudienceEstimateRequest {
  goal: CampaignGoal;
  targeting: AudienceTargetingInput;
}

export interface AudienceEstimateResponse {
  estimatedSize: number;
  indicatorValue: number;
  band: AudienceBand;
  summary: string;
}

export interface BudgetPlanInput {
  goal: CampaignGoal;
  dailyBudget: number;
  durationInDays: number;
  totalBudget: number;
}

export interface BudgetRecommendationResponse {
  recommendedBudget: number;
  estimatedReach: number;
  summary: string;
}

export interface PlacementPreview {
  platform: "Facebook" | "Google" | "LinkedIn";
  headline: string;
  description: string;
  body: string;
  callToAction: string;
}

export interface CreativeSuggestionsRequest {
  goal: CampaignGoal;
  audience: AudienceTargetingInput;
  budget: BudgetPlanInput;
}

export interface CreativeSuggestionsResponse {
  headlines: string[];
  descriptions: string[];
  adCopy: string[];
  imageAds: string[];
  videoAds: string[];
  carouselAds: string[];
  previews: PlacementPreview[];
}

export interface PlatformEstimateRequest {
  goal: CampaignGoal;
  totalBudget: number;
  selectedPlatforms: SupportedPlatform[];
}

export interface PlatformTrafficEstimate {
  platform: SupportedPlatform;
  estimatedTraffic: number;
  rationale: string;
}

export interface PlatformEstimateResponse {
  platforms: PlatformTrafficEstimate[];
  summary: string;
}

export interface LaunchCampaignRequest {
  goal: CampaignGoal;
  audience: AudienceTargetingInput;
  budget: BudgetPlanInput;
  creatives: CreativeSuggestionsResponse;
  selectedPlatforms: SupportedPlatform[];
}

export interface LaunchCampaignResponse {
  launchId: string;
  status: "queued";
  message: string;
  launchedPlatforms: SupportedPlatform[];
}

export function isCampaignGoal(value: string): value is CampaignGoal {
  return campaignGoals.includes(value as CampaignGoal);
}

export function isSupportedPlatform(value: string): value is SupportedPlatform {
  return supportedPlatforms.includes(value as SupportedPlatform);
}

export function isTargetGender(value: string): value is TargetGender {
  return ["Any", "Women", "Men"].includes(value);
}
