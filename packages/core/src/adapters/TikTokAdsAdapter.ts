import { withRetry } from "../utils/withRetry";
import { BaseAdapter } from "./BaseAdapter";
import { mapTikTokObjective } from "./mapObjective";
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

export class TikTokAdsAdapter extends BaseAdapter {
  platform: Platform = "TIKTOK";
  private advertiserId!: string;

  async connect(account: PlatformAccount) {
    await super.connect(account);
    this.advertiserId = account.externalId;
  }

  protected async request<T>(
    method: string,
    path: string,
    body?: any,
  ): Promise<T> {
    return withRetry(async () => {
      const res = await fetch(
        `https://business-api.tiktok.com/open_api/v1.3/${path}`,
        {
          method,
          headers: {
            "Access-Token": this.accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      return res.json();
    });
  }

  async createAssets(
    inputs: CreateAssetInput[],
  ): Promise<PlatformAssetResult[]> {
    return Promise.all(
      inputs.map(async (a) => {
        const res = await this.request<any>("POST", `asset/upload/`, {
          advertiser_id: this.advertiserId,
          name: a.name,
          type: a.type,
          url: a.url,
        });
        return { externalId: res.data.asset_id, platform: "TIKTOK" };
      }),
    );
  }

  async createCampaign(
    input: CreateCampaignInput,
  ): Promise<PlatformCampaignResult> {
    const objective = mapTikTokObjective(input.objective);
    const res = await this.request<any>("POST", "campaign/create/", {
      advertiser_id: this.advertiserId,
      campaign_name: input.name,
      objective_type: objective,
    });
    return {
      externalId: res.data.campaign_id,
      status: "PAUSED",
      platform: "TIKTOK",
    };
  }

  async createAdGroup(
    input: CreateAdGroupInput,
  ): Promise<PlatformAdGroupResult> {
    const res = await this.request<any>("POST", "adgroup/create/", {
      advertiser_id: this.advertiserId,
      campaign_id: input.campaignId,
      adgroup_name: input.name,
    });
    return { externalId: res.data.adgroup_id, platform: "TIKTOK" };
  }

  async createAds(inputs: CreateAdInput[]): Promise<PlatformAdResult[]> {
    return Promise.all(
      inputs.map(async (ad) => {
        const res = await this.request<any>("POST", "ad/create/", {
          advertiser_id: this.advertiserId,
          adgroup_id: ad.adGroupId,
          ad_name: ad.headline,
          ad_format: ad.type,
          creative_assets: ad.assetIds,
        });
        return {
          externalId: res.data.ad_id,
          status: "PAUSED",
          platform: "TIKTOK",
        };
      }),
    );
  }

  async createAudience(
    input: CreateAudienceInput,
  ): Promise<PlatformAudienceResult> {
    const res = await this.request<any>("POST", "audience/create/", {
      advertiser_id: this.advertiserId,
      audience_name: input.name,
      audience_type: input.type,
      rules: input.definition,
    });
    return { externalId: res.data.audience_id, platform: "TIKTOK" };
  }

  async getReport(query: ReportQuery): Promise<UnifiedReport> {
    const res = await this.request<any>("POST", "report/query/", {
      advertiser_id: this.advertiserId,
      metrics: query.metrics,
      dimensions: query.dimensions,
      date_range: query.dateRange,
    });
    return { rows: res.data.rows };
  }

  async trackConversion(event: ConversionEvent): Promise<void> {
    await this.request("POST", "conversion/track/", {
      advertiser_id: this.advertiserId,
      event,
    });
  }

  async forecastReach(input: ReachForecastInput): Promise<ReachForecastResult> {
    const res = await this.request<any>("POST", "reach/forecast/", {
      advertiser_id: this.advertiserId,
      budget: input.budget,
      targeting: input.targeting,
    });
    return {
      estimatedReach: res.data.reach,
      estimatedImpressions: res.data.impressions,
      platform: this.platform,
    };
  }
}
