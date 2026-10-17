import { expect, test } from "../support/fixtures";
import { signInTestCustomer } from "../support/helpers/customer-session";
import { resolveBaseUrl } from "../support/helpers/env";

test.describe("ads proxy", () => {
  test.beforeEach(async ({ request, context }, testInfo) => {
    await signInTestCustomer(request, testInfo.project.name, context);
  });
  test("persists execution logs for createCampaign and records downstream mock calls", async ({
    request,
  }) => {
    const creatives = [
      {
        headline: "Ship faster with Launchpad",
        description: "Cut campaign setup time for your team.",
        body: "Launch cross-platform campaigns from one workflow.",
        cta: "Start now",
      },
    ];

    const createCampaignResponse = await request.post(
      "/api/ads/createCampaign",
      {
        headers: { Origin: resolveBaseUrl() },
        data: {
          payload: {
            name: "Proxy integration campaign",
            campaignName: "Proxy integration campaign",
            goal: "Traffic",
            objective: "CLICKS",
            budget: {
              dailyBudget: 125,
              currency: "USD",
              durationInDays: 14,
              totalBudget: 1750,
            },
            targeting: {
              locations: ["US", "CA"],
              ageRange: [18, 65],
              interests: ["Technology", "SaaS"],
            },
            creatives,
            status: "PAUSED",
          },
          platforms: ["GOOGLE", "META", "TIKTOK"],
          source: "playwright-api-test",
        },
      },
    );

    expect(createCampaignResponse.ok()).toBeTruthy();

    const execution = (await createCampaignResponse.json()) as {
      executionId: string;
      uniformPayload: boolean;
      platformsInvoked: string[];
      success: boolean;
    };

    expect(execution.success).toBeTruthy();
    expect(execution.uniformPayload).toBeTruthy();
    expect(execution.platformsInvoked).toEqual(["GOOGLE", "META", "TIKTOK"]);

    const persistedResponse = await request.get(
      `/api/ads/executions?id=${execution.executionId}`,
    );
    expect(persistedResponse.ok()).toBeTruthy();

    const persisted = (await persistedResponse.json()) as {
      operation: string;
      requestPayload: {
        campaignName?: string;
        goal?: string;
        budget?: {
          durationInDays?: number;
          totalBudget?: number;
        };
        creatives?: Array<{
          headline?: string;
          description?: string;
          body?: string;
          cta?: string;
        }>;
      };
      success: boolean;
      invocations: Array<{
        platform: string;
        adapterPayload: {
          campaignName?: string;
          goal?: string;
          budget?: {
            durationInDays?: number;
            totalBudget?: number;
          };
          creatives?: Array<{
            headline?: string;
            description?: string;
            body?: string;
            cta?: string;
          }>;
        };
        downstreamPath: string | null;
        downstreamRequest: unknown;
        downstreamResponse: unknown;
        success: boolean | null;
      }>;
    };

    expect(persisted.operation).toBe("createCampaign");
    expect(persisted.success).toBeTruthy();
    expect(persisted.requestPayload.campaignName).toBe(
      "Proxy integration campaign",
    );
    expect(persisted.requestPayload.goal).toBe("Traffic");
    expect(persisted.requestPayload.budget?.durationInDays).toBe(14);
    expect(persisted.requestPayload.budget?.totalBudget).toBe(1750);
    expect(persisted.requestPayload.creatives).toEqual(creatives);
    expect(persisted.invocations).toHaveLength(3);

    const firstPayload = JSON.stringify(
      persisted.invocations[0]?.adapterPayload,
    );

    for (const invocation of persisted.invocations) {
      expect(invocation.success).toBeTruthy();
      expect(invocation.downstreamPath).toBeTruthy();
      expect(invocation.downstreamRequest).toBeTruthy();
      expect(invocation.downstreamResponse).toBeTruthy();
      expect(invocation.adapterPayload.campaignName).toBe(
        "Proxy integration campaign",
      );
      expect(invocation.adapterPayload.goal).toBe("Traffic");
      expect(invocation.adapterPayload.budget?.durationInDays).toBe(14);
      expect(invocation.adapterPayload.budget?.totalBudget).toBe(1750);
      expect(invocation.adapterPayload.creatives).toEqual(creatives);
      expect(JSON.stringify(invocation.adapterPayload)).toBe(firstPayload);
    }
  });

  test("opening a saved advertising plan never launches a provider campaign", async ({ page, request }) => {
    const created = await request.post("/api/workspace/campaigns", {
      headers: { Origin: resolveBaseUrl() },
      data: { type: "ADS", name: "Spring Growth Push", brief: "Introduce the spring collection to returning customers.",
        goal: "traffic", audience: "Returning customers", platforms: ["META", "GOOGLE"],
        plan: { currency: "GBP", totalBudget: "1400" }, creatives: [], status: "DRAFT" },
    });
    expect(created.status()).toBe(201);
    const { campaign } = await created.json();
    const writes: string[] = [];
    page.on("request", request => {
      if (request.method() === "POST" && /\/api\/ads\/(create|update|delete|launch)/.test(new URL(request.url()).pathname)) writes.push(request.url());
    });
    await page.goto(`/campaigns/${campaign.id}`);
    await expect(page.getByRole("heading", { name: "Spring Growth Push", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Advertising account readiness", exact: true })).toBeVisible();
    await expect(page.getByText(/Campaign creation and ad spending are currently disabled/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Launch Campaign", exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Spring Growth Push", exact: true })).toBeVisible();
    const saved = await request.get(`/api/workspace/campaigns/${campaign.id}`);
    expect((await saved.json()).campaign).toMatchObject({ id: campaign.id, type: "ADS", status: "DRAFT", plan: { currency: "GBP", totalBudget: "1400" } });
    expect(writes).toEqual([]);
  });
});
