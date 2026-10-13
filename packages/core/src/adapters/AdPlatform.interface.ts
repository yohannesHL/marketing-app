import {
  ConversionEvent,
  CreateAdGroupInput,
  CreateAdInput,
  CreateAssetInput,
  CreateAudienceInput,
  CreateCampaignInput,
  Platform,
  PlatformAccount,
  PlatformAdGroupResult,
  PlatformAdResult,
  PlatformAssetResult,
  PlatformAudienceResult,
  PlatformCampaignResult,
  ReachForecastInput,
  ReachForecastResult,
  ReportQuery,
  UnifiedReport,
} from "./types";

export interface AdsPlatformAdapter {
  platform: Platform;

  connect(account: PlatformAccount): Promise<void>;

  createAssets(input: CreateAssetInput[]): Promise<PlatformAssetResult[]>;

  createCampaign(input: CreateCampaignInput): Promise<PlatformCampaignResult>;

  createAdGroup(input: CreateAdGroupInput): Promise<PlatformAdGroupResult>;

  createAds(input: CreateAdInput[]): Promise<PlatformAdResult[]>;

  createAudience(input: CreateAudienceInput): Promise<PlatformAudienceResult>;

  getReport(query: ReportQuery): Promise<UnifiedReport>;

  trackConversion(event: ConversionEvent): Promise<void>;

  forecastReach?(input: ReachForecastInput): Promise<ReachForecastResult>;
}
