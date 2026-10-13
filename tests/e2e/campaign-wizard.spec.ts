import type { Page, Route } from "@playwright/test";

import { expect, test } from "../support/fixtures";
import { signInTestCustomer } from "../support/helpers/customer-session";
import { waitForNoPageErrors } from "../support/helpers/network";

async function completeAudienceStep(page: Page): Promise<void> {
  await expect(page.getByTestId("audience-estimate")).toContainText("Estimated audience size");
  await page.getByRole("button", { name: "Continue" }).click();
}

async function completeBudgetStep(page: Page): Promise<void> {
  await expect(page.getByTestId("budget-insights")).toContainText("Recommended startup launch budget");
  await page.getByRole("button", { name: "Continue" }).click();
}

async function completeCreativeStep(page: Page): Promise<void> {
  await expect(page.getByTestId("creative-workspace")).toContainText("Facebook preview");
  await page.getByRole("button", { name: "Continue" }).click();
}

async function completePlatformStep(page: Page): Promise<void> {
  await expect(page.getByTestId("platform-estimates")).toContainText("Estimated traffic");
  await page.getByRole("button", { name: "Continue" }).click();
}

test.describe("campaign creation wizard", () => {
  test.beforeEach(async ({ request, context }, testInfo) => {
    await signInTestCustomer(request, testInfo.project.name, context);
  });
  test("Given a marketer completes the guided workflow when launching a campaign then strategy guidance, estimates, editable creative, and launch confirmation are shown", async ({
    page,
    authSession,
    campaignWizardPage,
    campaignWizardSeed,
    factoryTracker,
  }) => {
    await test.step("Given the marketer opens the campaign creation wizard", async () => {
      expect(authSession.strategy).toBe("anonymous");
      expect(factoryTracker.snapshot()).toHaveLength(1);
      await campaignWizardPage.visit();
      await expect(campaignWizardPage.root).toBeVisible();
      await expect(campaignWizardPage.stepTitle).toContainText("Campaign Goal");
    });

    await test.step("When the marketer selects a goal and reviews strategy guidance", async () => {
      await campaignWizardPage.chooseGoal(campaignWizardSeed.goal);
      await expect(campaignWizardPage.goalGuidance).toContainText("Strategy guidance");
      await expect(campaignWizardPage.goalGuidance).toContainText(campaignWizardSeed.goal);
      await campaignWizardPage.continueToNextStep();
    });

    await test.step("And the marketer defines audience targeting", async () => {
      await campaignWizardPage.fillAudience(campaignWizardSeed);
      await campaignWizardPage.uploadCustomAudience(
        campaignWizardSeed.customAudienceFileName,
        campaignWizardSeed.customAudienceContents,
        "text/csv",
      );
      await completeAudienceStep(page);
    });

    await test.step("And the marketer sets a budget plan", async () => {
      await campaignWizardPage.fillBudget(campaignWizardSeed);
      await completeBudgetStep(page);
    });

    await test.step("And the marketer generates and edits creatives", async () => {
      await campaignWizardPage.generateCreatives();
      await expect(campaignWizardPage.creativeWorkspace).toContainText("Google preview");
      await campaignWizardPage.editGeneratedCreative(campaignWizardSeed);
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
      await page.getByRole("button", { name: "Launch Campaign" }).click();
      await expect(campaignWizardPage.launchResult).toContainText("Campaign launch queued");
    });
  });

  test("Given validation-sensitive wizard steps when required data is incomplete or changed then progression is gated and prior entries remain intact", async ({
    campaignWizardPage,
    campaignWizardSeed,
  }) => {
    await test.step("Given the marketer opens the wizard with no selections yet", async () => {
      await campaignWizardPage.visit();
      await expect(campaignWizardPage.continueButton).toBeDisabled();
    });

    await test.step("When the marketer provides a goal and incomplete audience data", async () => {
      await campaignWizardPage.chooseGoal(campaignWizardSeed.goal);
      await campaignWizardPage.continueToNextStep();
      await expect(campaignWizardPage.stepTitle).toContainText("Audience Targeting");
      await expect(campaignWizardPage.continueButton).toBeDisabled();

      await campaignWizardPage.uploadCustomAudience(
        campaignWizardSeed.invalidAudienceFileName,
        campaignWizardSeed.invalidAudienceContents,
        "application/pdf",
      );

      await expect(campaignWizardPage.root).toContainText("Upload a CSV or TXT audience file under 5 MB.");
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
      await campaignWizardPage.page.getByLabel("Campaign duration").fill("5");
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

    await test.step("Given the marketer reaches the review step with a launch-ready draft", async () => {
      await campaignWizardPage.visit();
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
      await page.route("**/api/campaign-wizard/launch", async (route: Route) => {
        launchAttempts += 1;

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
      await expect(page.getByRole("button", { name: "Launch Campaign" })).toBeEnabled();
      await page.getByRole("button", { name: "Launch Campaign" }).click();
    });

    await test.step("Then the retry succeeds without losing the review context", async () => {
      await expect(campaignWizardPage.launchResult).toContainText("Campaign launch queued");
    });
  });
});
