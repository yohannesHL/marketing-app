import { withRetry } from "../utils/withRetry";
import { BaseAdapter } from "./BaseAdapter";
import { mapGoogleObjective } from "./mapObjective";
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
    return withRetry(async () => {
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
