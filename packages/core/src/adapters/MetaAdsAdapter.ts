import { withRetry } from "../utils/withRetry";
import { BaseAdapter } from "./BaseAdapter";
import { mapMetaObjective } from "./mapObjective";
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

export class MetaAdsAdapter extends BaseAdapter {
  platform: Platform = "META";
  private accountId!: string;

  async connect(account: PlatformAccount) {
    await super.connect(account);
    this.accountId = account.externalId;
  }

  protected async request<T>(
    method: string,
    path: string,
    body?: any,
  ): Promise<T> {
    return withRetry(async () => {
      const url = `https://graph.facebook.com/v18.0/${path}?access_token=${this.accessToken}`;
      const res = await fetch(url, {
        method,
        body: method === "POST" ? JSON.stringify(body) : undefined,
        headers: { "Content-Type": "application/json" },
      });
      return res.json();
    });
  }

  async createAssets(
    inputs: CreateAssetInput[],
  ): Promise<PlatformAssetResult[]> {
    return Promise.all(
      inputs.map(async (a) => {
        const res = await this.request<any>(
          "POST",
          `act_${this.accountId}/adimages`,
          { name: a.name, bytes: a.url },
        );
        return { externalId: res.images?.hash, platform: "META" };
      }),
    );
  }

  async createCampaign(
    input: CreateCampaignInput,
  ): Promise<PlatformCampaignResult> {
    const objective = mapMetaObjective(input.objective);
    const res = await this.request<any>(
      "POST",
      `act_${this.accountId}/campaigns`,
      { name: input.name, objective, status: input.status ?? "PAUSED" },
    );
    return {
      externalId: res.id,
      status: input.status ?? "PAUSED",
      platform: "META",
    };
  }

  async createAdGroup(
    input: CreateAdGroupInput,
  ): Promise<PlatformAdGroupResult> {
    const res = await this.request<any>(
      "POST",
      `act_${this.accountId}/adsets`,
      {
        name: input.name,
        campaign_id: input.campaignId,
        daily_budget: input.budget,
        status: "PAUSED",
      },
    );
    return { externalId: res.id, platform: "META" };
  }

  async createAds(inputs: CreateAdInput[]): Promise<PlatformAdResult[]> {
    return Promise.all(
      inputs.map(async (ad) => {
        const res = await this.request<any>(
          "POST",
          `act_${this.accountId}/ads`,
          {
            name: ad.headline,
            adset_id: ad.adGroupId,
            creative: { asset_feed_spec: { images: ad.assetIds } },
            status: "PAUSED",
          },
        );
        return { externalId: res.id, status: "PAUSED", platform: "META" };
      }),
    );
  }

  async createAudience(
    input: CreateAudienceInput,
  ): Promise<PlatformAudienceResult> {
    const res = await this.request<any>(
      "POST",
      `act_${this.accountId}/customaudiences`,
      {
        name: input.name,
        subtype: input.type,
        description: JSON.stringify(input.definition),
      },
    );
    return { externalId: res.id, platform: "META" };
  }

  async getReport(query: ReportQuery): Promise<UnifiedReport> {
    const res = await this.request<any>(
      "GET",
      `act_${this.accountId}/insights?fields=${query.metrics.join(",")}`,
    );
    return {
      rows: res.data.map((r: any) => ({
        impressions: Number(r.impressions),
        clicks: Number(r.clicks),
      })),
    };
  }

  async trackConversion(event: ConversionEvent): Promise<void> {
    await this.request("POST", `act_${this.accountId}/events`, {
      data: [event],
    });
  }

  async forecastReach(input: ReachForecastInput): Promise<ReachForecastResult> {
    const res = await this.request<any>(
      "POST",
      `act_${this.accountId}/reachestimate`,
      input,
    );
    return {
      estimatedReach: res.data.reach,
      estimatedImpressions: res.data.impressions,
      platform: this.platform,
    };
  }
}
