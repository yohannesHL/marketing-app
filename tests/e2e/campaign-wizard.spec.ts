import type { Page, Route } from "@playwright/test";

import { expect, test } from "../support/fixtures";
import { signInTestCustomer } from "../support/helpers/customer-session";
import { waitForNoPageErrors } from "../support/helpers/network";

async function completeAudienceStep(page: Page): Promise<void> {
  await expect(page.getByTestId("audience-estimate")).toContainText("Estimated Reach");
  await expect(page.getByTestId("audience-estimate")).toContainText(/people estimated in a/);
  await page.getByRole("button", { name: "Continue" }).click();
}

async function completeBudgetStep(page: Page): Promise<void> {
  await expect(page.getByTestId("budget-insights")).toContainText("Recommended");
  await expect(page.getByTestId("budget-insights")).toContainText("Est. Reach");
  await page.getByRole("button", { name: "Continue" }).click();
}

async function completeCreativeStep(page: Page): Promise<void> {
  await expect(page.getByTestId("creative-workspace")).toContainText("AD PREVIEW");
  await page.getByRole("button", { name: "Continue" }).click();
}

async function completePlatformStep(page: Page): Promise<void> {
  await expect(page.getByTestId("platform-estimates")).toContainText("Estimated traffic");
  await expect(page.getByTestId("platform-estimates")).toContainText("visits");
  await page.getByRole("button", { name: "Continue" }).click();
}

test.describe("campaign creation wizard", () => {
  test.beforeEach(async ({ request, context }, testInfo) => {
    await signInTestCustomer(request, testInfo.project.name, context);
  });
  test("Given a marketer completes the guided workflow when launching a campaign then strategy guidance, estimates, editable creative, and launch confirmation are shown", async ({
    page,
    campaignWizardPage,
    campaignWizardSeed,
    factoryTracker,
  }, testInfo) => {
    await test.step("Given the marketer opens the campaign creation wizard", async () => {
      expect(factoryTracker.snapshot()).toHaveLength(1);
      await campaignWizardPage.visit();
      await expect(campaignWizardPage.root).toBeVisible();
      await expect(campaignWizardPage.stepTitle).toContainText("Campaign Goal");
      await page.getByLabel("Campaign Name").fill(campaignWizardSeed.campaignName);
    });

    await test.step("When the marketer selects a goal and reviews strategy guidance", async () => {
      await campaignWizardPage.chooseGoal(campaignWizardSeed.goal);
      await expect(campaignWizardPage.goalGuidance).toContainText("Strategy guidance");
      await expect(campaignWizardPage.goalGuidance).toContainText(campaignWizardSeed.goal);
      await expect(campaignWizardPage.goalGuidance).toContainText("Recommended objective:");
      await campaignWizardPage.continueToNextStep();
    });

    await test.step("And the marketer defines audience targeting", async () => {
      await campaignWizardPage.fillAudience(campaignWizardSeed);
      await campaignWizardPage.uploadCustomAudience(
        campaignWizardSeed.customAudienceFileName,
        campaignWizardSeed.customAudienceContents,
        "text/csv",
      );
      await expect(campaignWizardPage.root).toContainText(campaignWizardSeed.customAudienceFileName);
      await completeAudienceStep(page);
    });

    await test.step("And the marketer sets a budget plan", async () => {
      await campaignWizardPage.fillBudget(campaignWizardSeed);
      await completeBudgetStep(page);
    });

    await test.step("And the marketer generates and edits creatives", async () => {
      await campaignWizardPage.generateCreatives();
      await expect(page.getByPlaceholder("Enter headline", { exact: true }).first()).not.toHaveValue("");
      await campaignWizardPage.editGeneratedCreative(campaignWizardSeed);
      await expect(campaignWizardPage.creativeWorkspace).toContainText(campaignWizardSeed.editedHeadline);
      await expect(campaignWizardPage.creativeWorkspace).toContainText(campaignWizardSeed.editedDescription);
      await completeCreativeStep(page);
    });

    await test.step("And the marketer selects launch platforms", async () => {
      for (const platform of campaignWizardSeed.selectedPlatforms) {
        await campaignWizardPage.setPlatformSelection(platform, true);
      }

      await completePlatformStep(page);
    });

    await test.step("Then the final review and launch receipt reflect the configured campaign", async () => {
      await waitForNoPageErrors(page);
      await expect(campaignWizardPage.reviewSummary).toContainText(campaignWizardSeed.location);
      await expect(campaignWizardPage.reviewSummary).toContainText(campaignWizardSeed.editedHeadline);
      await expect(campaignWizardPage.reviewSummary).toContainText("Google");
      await expect(campaignWizardPage.reviewSummary).toContainText("Meta");
      const reviewScreenshot = testInfo.outputPath("wizard-review.png");
      await page.screenshot({ path: reviewScreenshot, fullPage: true });
      await testInfo.attach("wizard-review", {
        path: reviewScreenshot,
        contentType: "image/png",
      });
      const launchRequest = page.waitForRequest((request) =>
        new URL(request.url()).pathname === "/api/ads/createCampaign" && request.method() === "POST",
      );
      await page.getByRole("button", { name: "Launch Campaign" }).click();
      expect((await launchRequest).postDataJSON()).toMatchObject({
        payload: {
          campaignName: campaignWizardSeed.campaignName,
          goal: campaignWizardSeed.goal,
          targeting: {
            locations: [campaignWizardSeed.location],
            ageRange: [25, 34],
            interests: campaignWizardSeed.interests,
          },
          budget: { dailyBudget: 250, durationInDays: 14, totalBudget: 3500 },
          status: "PAUSED",
        },
        platforms: ["GOOGLE", "META", "TIKTOK"],
      });
      await expect(campaignWizardPage.launchResult).toContainText("Campaign demo saved");
      await expect(campaignWizardPage.launchResult).toContainText("Uniform payload: confirmed");
      const receiptScreenshot = testInfo.outputPath("wizard-launch-receipt.png");
      await page.screenshot({ path: receiptScreenshot, fullPage: true });
      await testInfo.attach("wizard-launch-receipt", {
        path: receiptScreenshot,
        contentType: "image/png",
      });
    });
  });

  test("Given validation-sensitive wizard steps when required data is incomplete or changed then progression is gated and prior entries remain intact", async ({
    campaignWizardPage,
    campaignWizardSeed,
  }, testInfo) => {
    await test.step("Given the marketer opens the wizard with no selections yet", async () => {
      await campaignWizardPage.visit();
      await expect(campaignWizardPage.continueButton).toBeDisabled();

    });

    await test.step("When the marketer provides a goal and incomplete audience data", async () => {
      await campaignWizardPage.chooseGoal(campaignWizardSeed.goal);
      await campaignWizardPage.continueToNextStep();
      await expect(campaignWizardPage.stepTitle).toContainText("Audience Targeting");
      await expect(campaignWizardPage.continueButton).toBeDisabled();

      await campaignWizardPage.fillAudience(campaignWizardSeed);
      await expect(campaignWizardPage.continueButton).toBeEnabled();

      await campaignWizardPage.uploadCustomAudience(
        campaignWizardSeed.invalidAudienceFileName,
        campaignWizardSeed.invalidAudienceContents,
        "application/pdf",
      );

      await expect(campaignWizardPage.root).toContainText("Upload a CSV or TXT audience file under 5 MB.");
      await expect(campaignWizardPage.continueButton).toBeDisabled();
      await expect(campaignWizardPage.audienceEstimate).toContainText("Replace the rejected file");
      await expect(campaignWizardPage.audienceEstimate).not.toContainText("Calculating audience estimate");
      const uploadScreenshot = testInfo.outputPath("invalid-audience-upload.png");
      await campaignWizardPage.page.screenshot({ path: uploadScreenshot, fullPage: true });
      await testInfo.attach("invalid-audience-upload", {
        path: uploadScreenshot,
        contentType: "image/png",
      });
    });

    await test.step("And the marketer completes audience fields and adjusts the budget in different orders", async () => {
      await campaignWizardPage.fillAudience(campaignWizardSeed);
      await campaignWizardPage.uploadCustomAudience(
        campaignWizardSeed.customAudienceFileName,
        campaignWizardSeed.customAudienceContents,
        "text/csv",
      );
      await completeAudienceStep(campaignWizardPage.page);

      await campaignWizardPage.fillBudget({
        dailyBudget: "100",
        durationInDays: "10",
        totalBudget: "1000",
      });

      await expect(campaignWizardPage.page.getByLabel("Total budget")).toHaveValue("1000");
      await campaignWizardPage.page.getByLabel("Total budget").fill("1500");
      await expect(campaignWizardPage.page.getByLabel("Daily budget")).toHaveValue("150");
      await campaignWizardPage.page.getByLabel("Duration (days)").fill("5");
      await expect(campaignWizardPage.page.getByLabel("Daily budget")).toHaveValue("300");
    });

    await test.step("Then returning to the previous step preserves the earlier audience data", async () => {
      await campaignWizardPage.goBack();
      await expect(campaignWizardPage.stepTitle).toContainText("Audience Targeting");
      await expect(campaignWizardPage.page.getByLabel("Location")).toHaveValue(campaignWizardSeed.location);
      await expect(campaignWizardPage.page.getByLabel("Industry")).toHaveValue(campaignWizardSeed.industry);
    });
  });

  test("Given creative generation fails when the marketer requests AI assistance then the error is explicit and earlier campaign data is preserved", async ({
    page,
    campaignWizardPage,
    campaignWizardSeed,
  }) => {
    await test.step("Given the marketer has completed goal, audience, and budget setup", async () => {
      await campaignWizardPage.visit();
      await page.getByLabel("Campaign Name").fill(campaignWizardSeed.campaignName);
      await campaignWizardPage.chooseGoal(campaignWizardSeed.goal);
      await campaignWizardPage.continueToNextStep();
      await campaignWizardPage.fillAudience(campaignWizardSeed);
      await completeAudienceStep(page);
      await campaignWizardPage.fillBudget(campaignWizardSeed);
      await completeBudgetStep(page);
    });

    await test.step("When creative generation returns an error", async () => {
      await page.route("**/api/campaign-wizard/creative-suggestions", async (route: Route) => {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ message: "Creative generation is temporarily unavailable." }),
        });
      });

      await campaignWizardPage.generateCreatives();
    });

    await test.step("Then the failure is surfaced without losing prior campaign inputs", async () => {
      await expect(campaignWizardPage.root).toContainText("Creative generation is temporarily unavailable.");
      await campaignWizardPage.goBack();
      await expect(campaignWizardPage.page.getByLabel("Daily budget")).toHaveValue(campaignWizardSeed.dailyBudget);
      await campaignWizardPage.goBack();
      await expect(campaignWizardPage.page.getByLabel("Location")).toHaveValue(campaignWizardSeed.location);
    });
  });

  test("Given launch submission fails once when the marketer is ready to publish then the review state stays visible and retry succeeds safely", async ({
    page,
    campaignWizardPage,
    campaignWizardSeed,
  }) => {
    let launchAttempts = 0;
    const submittedDrafts: unknown[] = [];

    await test.step("Given the marketer reaches the review step with a launch-ready draft", async () => {
      await campaignWizardPage.visit();
      await page.getByLabel("Campaign Name").fill(campaignWizardSeed.campaignName);
      await campaignWizardPage.chooseGoal(campaignWizardSeed.goal);
      await campaignWizardPage.continueToNextStep();
      await campaignWizardPage.fillAudience(campaignWizardSeed);
      await completeAudienceStep(page);
      await campaignWizardPage.fillBudget(campaignWizardSeed);
      await completeBudgetStep(page);
      await campaignWizardPage.generateCreatives();
      await campaignWizardPage.editGeneratedCreative(campaignWizardSeed);
      await completeCreativeStep(page);

      for (const platform of campaignWizardSeed.selectedPlatforms) {
        await campaignWizardPage.setPlatformSelection(platform, true);
      }

      await completePlatformStep(page);
      await expect(campaignWizardPage.reviewSummary).toContainText(campaignWizardSeed.editedHeadline);
    });

    await test.step("When the first launch attempt fails and the marketer retries", async () => {
      await page.route("**/api/ads/createCampaign", async (route: Route) => {
        launchAttempts += 1;
        submittedDrafts.push(route.request().postDataJSON());

        if (launchAttempts === 1) {
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ message: "Launch submission failed. Please review the campaign and retry." }),
          });
          return;
        }

        await route.continue();
      });

      await page.getByRole("button", { name: "Launch Campaign" }).click();
      await expect(campaignWizardPage.root).toContainText("Launch submission failed. Please review the campaign and retry.");
      await expect(campaignWizardPage.reviewSummary).toContainText(campaignWizardSeed.location);
      await expect(campaignWizardPage.reviewSummary).toContainText(campaignWizardSeed.editedHeadline);
      await expect(campaignWizardPage.launchResult).not.toBeVisible();
      await expect(page.getByRole("button", { name: "Launch Campaign" })).toBeEnabled();
      await page.getByRole("button", { name: "Launch Campaign" }).click();
    });

    await test.step("Then the retry succeeds without losing the review context", async () => {
      await expect(campaignWizardPage.launchResult).toContainText("Campaign demo saved");
      await expect(campaignWizardPage.launchResult).toContainText("Uniform payload: confirmed");
      expect(launchAttempts).toBe(2);
      expect(submittedDrafts[1]).toEqual(submittedDrafts[0]);
    });
  });
});
