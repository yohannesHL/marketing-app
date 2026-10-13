import { AdsPlatformAdapter } from "./AdPlatform.interface";
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
  ReportQuery,
  UnifiedReport,
} from "./types";

export abstract class BaseAdapter implements AdsPlatformAdapter {
  abstract platform: Platform;

  protected accessToken!: string;

  async connect(account: PlatformAccount) {
    this.accessToken = account.accessToken;
  }

  protected abstract request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T>;

  abstract createAssets(
    input: CreateAssetInput[],
  ): Promise<PlatformAssetResult[]>;
  abstract createCampaign(
    input: CreateCampaignInput,
  ): Promise<PlatformCampaignResult>;
  abstract createAdGroup(
    input: CreateAdGroupInput,
  ): Promise<PlatformAdGroupResult>;
  abstract createAds(input: CreateAdInput[]): Promise<PlatformAdResult[]>;
  abstract createAudience(
    input: CreateAudienceInput,
  ): Promise<PlatformAudienceResult>;
  abstract getReport(query: ReportQuery): Promise<UnifiedReport>;
  abstract trackConversion(event: ConversionEvent): Promise<void>;
}
