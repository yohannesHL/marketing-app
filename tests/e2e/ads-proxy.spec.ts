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

  test("launching from the wizard triggers the unified ads proxy and shows the execution result", async ({
    page,
  }) => {
    await page.goto("/campaigns/create");

    await page.getByLabel("Campaign Name").fill("Spring Growth Push");

    await page.getByRole("button", { name: /Traffic/i }).click();
    await page.getByRole("button", { name: "Continue" }).click();

    await page.getByLabel("Location").fill("US, UK, Canada");
    await page.getByLabel("Min Age").fill("18");
    await page.getByLabel("Max Age").fill("65");
    await page.getByRole("button", { name: "Technology" }).click();
    await page.getByRole("button", { name: "Continue" }).click();

    await page.getByLabel("Daily Budget").fill("100");
    await page.getByLabel("Duration (days)").fill("14");
    await page.getByLabel("Total Budget").fill("1400");
    await page.getByRole("button", { name: "Continue" }).click();

    await page
      .getByPlaceholder("Enter headline")
      .first()
      .fill("Scale demand faster");
    await page
      .getByPlaceholder("Enter description")
      .first()
      .fill("Reach high-intent buyers across channels.");
    await page
      .getByPlaceholder("Enter body text")
      .first()
      .fill("Launch one campaign and syndicate the same message everywhere.");
    await page
      .getByPlaceholder("Enter CTA (e.g., Try It Free!)")
      .first()
      .fill("Get started");
    await page.getByRole("button", { name: "Continue" }).click();

    await page.getByRole("button", { name: /Meta Ads/i }).click();
    await page.getByRole("button", { name: /Google Ads/i }).click();
    await page.getByRole("button", { name: /TikTok Ads/i }).click();
    await page.getByRole("button", { name: "Continue" }).click();

    const launchRequestPromise = page.waitForRequest(
      (request) =>
        request.url().includes("/api/ads/createCampaign") &&
        request.method() === "POST",
    );

    await page.getByRole("button", { name: "Launch Campaign" }).click();

    const launchRequest = await launchRequestPromise;
    expect(launchRequest.postDataJSON()).toEqual({
      payload: {
        name: "Spring Growth Push",
        campaignName: "Spring Growth Push",
        goal: "Traffic",
        objective: "CLICKS",
        budget: {
          dailyBudget: 100,
          currency: "USD",
          durationInDays: 14,
          totalBudget: 1400,
        },
        targeting: {
          locations: ["US", "UK", "Canada"],
          ageRange: [18, 65],
          interests: ["Technology"],
        },
        creatives: [
          {
            headline: "Scale demand faster",
            description: "Reach high-intent buyers across channels.",
            body: "Launch one campaign and syndicate the same message everywhere.",
            cta: "Get started",
          },
        ],
        status: "PAUSED",
      },
      platforms: ["META", "GOOGLE", "TIKTOK"],
      source: "wizard-launch",
    });

    const launchResult = page.getByTestId("launch-result");
    await expect(launchResult).toContainText("Uniform payload: confirmed");
    await expect(launchResult).toContainText("GOOGLE");
    await expect(launchResult).toContainText("META");
    await expect(launchResult).toContainText("TIKTOK");
  });
});
