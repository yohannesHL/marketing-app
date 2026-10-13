import { test, expect } from "../support/fixtures";
import { runWithDocumentResponse, waitForNoPageErrors } from "../support/helpers/network";

test.describe("marketing home page", () => {
  test("Given the default marketing workspace when the landing page loads then the official homepage guides users to the campaign wizard", async ({
    page,
    authSession,
    homePage,
    marketingPageSeed,
    factoryTracker,
  }) => {
    await test.step("Given reusable seed data and an anonymous session", async () => {
      expect(authSession.strategy).toBe("anonymous");
      expect(marketingPageSeed.campaignId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(factoryTracker.snapshot()).toHaveLength(1);
    });

    await test.step("When the landing page loads", async () => {
      await runWithDocumentResponse(page, async () => {
        await homePage.visit();
      }, "/");
    });

    await test.step("Then the official homepage content and campaign wizard CTA are visible", async () => {
      await waitForNoPageErrors(page);
      await expect(homePage.root).toBeVisible();
      await expect(homePage.hero).toContainText("Launch campaigns with confidence");
      await expect(homePage.heading).toBeVisible();
      await expect(homePage.ctaGroup).toContainText("Open campaign wizard");
      await expect(homePage.wizardCta).toHaveAttribute("href", "/campaigns/create");
      await expect(homePage.highlights).toContainText("Goal-first planning");
      await expect(homePage.highlights).toContainText("Audience clarity");
      await expect(homePage.highlights).toContainText("Launch review");
    });
  });
});
