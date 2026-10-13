import { withRetry } from "../utils/withRetry";
import { BaseAdapter } from "./BaseAdapter";
import {
  CreateCampaignInput,
  Platform,
  PlatformAccount,
  PlatformCampaignResult,
} from "./types";

export class XAdsAdapter extends BaseAdapter {
  platform: Platform = "X";
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
    const url = `https://graph.facebook.com/v18.0/${path}?access_token=${this.accessToken}`;

    return withRetry(async () => {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "POST" ? JSON.stringify(body) : undefined,
      });
      return res.json();
    });
  }

  async createCampaign(
    input: CreateCampaignInput,
  ): Promise<PlatformCampaignResult> {
    const res = await this.request<any>(
      "POST",
      `act_${this.accountId}/campaigns`,
      {
        name: input.name,
        objective: mapObjective(input.objective),
        status: input.status ?? "PAUSED",
      },
    );

    return {
      externalId: res.id,
      status: input.status ?? "PAUSED",
      platform: "META",
    };
  }
}
