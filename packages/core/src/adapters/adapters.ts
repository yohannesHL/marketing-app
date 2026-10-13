// ===============================
// googleAdapter.ts
// ===============================
import { BaseAdapter } from "./baseAdapter";
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
  mapGoogleObjective,
} from "./types";

export class GoogleAdsAdapter extends BaseAdapter {
  platform: Platform = "GOOGLE";
  private customerId!: string;

  async connect(account: PlatformAccount) {
    await super.connect(account);
    this.customerId = account.externalId;
  }

  protected async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    return this.withRetry(async () => {
      const res = await fetch(`https://googleads.googleapis.com/v16/${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
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
          `customers/${this.customerId}/assets:mutate`,
          { operations: [{ create: { name: a.name, type: a.type } }] },
        );
        return { externalId: res.results[0].resourceName, platform: "GOOGLE" };
      }),
    );
  }

  async createCampaign(
    input: CreateCampaignInput,
  ): Promise<PlatformCampaignResult> {
    const objective = mapGoogleObjective(input.objective);
    const res = await this.request<any>(
      "POST",
      `customers/${this.customerId}/campaigns:mutate`,
      {
        operations: [
          {
            create: {
              name: input.name,
              advertisingChannelType: objective,
              status: input.status ?? "PAUSED",
              campaignBudget: {
                amountMicros: input.budget.dailyBudget * 1_000_000,
                currencyCode: input.budget.currency,
              },
            },
          },
        ],
      },
    );
    return {
      externalId: res.results[0].resourceName,
      status: input.status ?? "PAUSED",
      platform: "GOOGLE",
    };
  }

  async createAdGroup(
    input: CreateAdGroupInput,
  ): Promise<PlatformAdGroupResult> {
    const res = await this.request<any>(
      "POST",
      `customers/${this.customerId}/adGroups:mutate`,
      {
        operations: [
          {
            create: {
              name: input.name,
              campaign: input.campaignId,
              status: "PAUSED",
              type: "SEARCH_STANDARD",
            },
          },
        ],
      },
    );
    return { externalId: res.results[0].resourceName, platform: "GOOGLE" };
  }

  async createAds(inputs: CreateAdInput[]): Promise<PlatformAdResult[]> {
    return Promise.all(
      inputs.map(async (ad) => {
        const res = await this.request<any>(
          "POST",
          `customers/${this.customerId}/ads:mutate`,
          {
            operations: [
              {
                create: {
                  adGroup: ad.adGroupId,
                  assets: ad.assetIds,
                  type: ad.type,
                },
              },
            ],
          },
        );
        return {
          externalId: res.results[0].resourceName,
          status: "PAUSED",
          platform: "GOOGLE",
        };
      }),
    );
  }

  async createAudience(
    input: CreateAudienceInput,
  ): Promise<PlatformAudienceResult> {
    const res = await this.request<any>(
      "POST",
      `customers/${this.customerId}/userLists:mutate`,
      {
        operations: [
          {
            create: {
              name: input.name,
              description: JSON.stringify(input.definition),
            },
          },
        ],
      },
    );
    return { externalId: res.results[0].resourceName, platform: "GOOGLE" };
  }

  async getReport(query: ReportQuery): Promise<UnifiedReport> {
    const res = await this.request<any>(
      "POST",
      `customers/${this.customerId}/googleAds:search`,
      {
        query: `SELECT campaign.id, metrics.impressions, metrics.clicks FROM campaign`,
      },
    );
    return {
      rows: res.results.map((r: any) => ({
        campaignId: r.campaign.id,
        impressions: r.metrics.impressions,
        clicks: r.metrics.clicks,
      })),
    };
  }

  async trackConversion(event: ConversionEvent): Promise<void> {
    await this.request(
      "POST",
      `customers/${this.customerId}/conversionActions:upload`,
      { events: [event] },
    );
  }

  async forecastReach(input: ReachForecastInput): Promise<ReachForecastResult> {
    const res = await this.request<any>(
      "POST",
      `customers/${this.customerId}/reachForecast:generate`,
      input,
    );
    return {
      estimatedReach: res.reach,
      estimatedImpressions: res.impressions,
      platform: "GOOGLE",
    };
  }
}

// ===============================
// metaAdapter.ts
// ===============================
import { mapObjective } from "./types";

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
    return this.withRetry(async () => {
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
    const objective = mapObjective(input.objective);
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
      platform: "META",
    };
  }
}

// ===============================
// tikTokAdapter.ts
// ===============================
import { mapTikTokObjective } from "./types";

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
    return this.withRetry(async () => {
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
      platform: "TIKTOK",
    };
  }
}
