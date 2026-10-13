export type Platform = "GOOGLE" | "META" | "TIKTOK" | "LINKEDIN" | "X";

export interface PlatformAccount {
  id: string;
  platform: Platform;

  // External identifiers (critical)
  externalId: string; // customerId | adAccountId | advertiserId

  name?: string;
  currency?: string;
  timezone?: string;

  accessToken: string;
  refreshToken?: string;

  meta?: Record<string, any>; // platform-specific config
}

export interface PlatformUserAccount {
  id: string;
  platform: Platform;

  userId: string;

  // External identifiers (critical)
  externalId: string; // customerId | adAccountId | advertiserId

  name?: string;
  currency?: string;
  timezone?: string;

  accessToken: string;
  refreshToken?: string;

  meta?: Record<string, any>; // platform-specific config
}

export type AssetType = "IMAGE" | "VIDEO" | "TEXT" | "HTML";

export interface CreateAssetInput {
  name: string;
  type: AssetType;
  url?: string;
  text?: string;
  metadata?: Record<string, any>;
}

export interface PlatformAssetResult {
  externalId: string;
  status?: string;
  platform: Platform;
}

export type CampaignObjective =
  | "CONVERSIONS"
  | "CLICKS"
  | "AWARENESS"
  | "LEADS"
  | "APP_INSTALLS";

export interface CampaignCreativeInput {
  headline?: string;
  description?: string;
  body?: string;
  cta?: string;
}

export interface CreateCampaignInput {
  name: string;
  campaignName?: string;
  goal?: string;
  objective: CampaignObjective;
  // Legacy payload field only; server sessions determine ownership.
  userId?: string;

  budget: {
    dailyBudget: number;
    currency: string;
    durationInDays?: number;
    totalBudget?: number;
  };

  targeting?: {
    locations?: string[];
    ageRange?: [number, number];
    interests?: string[];
  };

  creatives?: CampaignCreativeInput[];

  status?: "ACTIVE" | "PAUSED";

  assetSetId?: string;
}

export interface PlatformCampaignResult {
  externalId: string;
  status: string;
  platform: Platform;
}

export interface CreateAdGroupInput {
  name: string;
  campaignId: string;

  budget?: number;

  targeting?: {
    locations?: string[];
    audiences?: string[];
  };

  bid?: {
    strategy: "MAX_CONVERSIONS" | "MANUAL_CPC";
    amount?: number;
  };
}

export interface PlatformAdGroupResult {
  externalId: string;
  platform: Platform;
}

export interface CreateAdInput {
  adGroupId: string;
  type: "RESPONSIVE" | "VIDEO" | "IMAGE";

  assetIds: string[];

  headline?: string;
  description?: string;
  cta?: string;

  landingPageUrl?: string;
}

export interface PlatformAdResult {
  externalId: string;
  status: string;
  platform: Platform;
}

export interface CreateAudienceInput {
  type: "CUSTOM" | "LOOKALIKE" | "PIXEL";

  name?: string;

  definition: {
    event?: string;
    days?: number;
    rules?: Record<string, any>;
  };
}

export interface PlatformAudienceResult {
  externalId: string;
  platform: Platform;
}

export interface ReportQuery {
  metrics: string[];
  dimensions: string[];
  dateRange: {
    from: string;
    to: string;
  };

  filters?: Record<string, any>;
}

export interface PlatformExecutionResult<T> {
  platform: Platform;
  success: boolean;
  data?: T;
  error?: {
    message: string;
    code?: string;
    raw?: unknown;
  };
}

export interface UnifiedReportRow {
  date?: string;
  campaignId?: string;
  adGroupId?: string;

  impressions?: number;
  clicks?: number;
  conversions?: number;
  cost?: number;
  revenue?: number;
}

export interface UnifiedReport {
  rows: UnifiedReportRow[];
}

export interface ConversionEvent {
  event: string;
  value?: number;
  currency?: string;

  user?: {
    emailHash?: string;
    phoneHash?: string;
  };

  metadata?: Record<string, any>;
}

export interface ReachForecastInput {
  budget: number;

  targeting?: {
    locations?: string[];
    interests?: string[];
  };
}

export interface ReachForecastResult {
  estimatedReach: number;
  estimatedImpressions: number;
  platform: Platform;
}

export interface PlatformCampaignResult {
  externalId: string;
  status: string;
}
