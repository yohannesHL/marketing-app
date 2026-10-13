import { expect, test } from "../support/fixtures";
import { runWithDocumentResponse, waitForNoPageErrors } from "../support/helpers/network";

test.describe("Sprint 1 Story 1 - App workspace consumption (ATDD)", () => {
  test.skip("[P0] Given the marketing workspace when the landing page loads then the official homepage renders through the @launchpad/ui workspace import path", async ({
    page,
    homePage,
  }) => {
    await runWithDocumentResponse(
      page,
      async () => {
        await homePage.visit();
      },
      "/",
    );

    await waitForNoPageErrors(page);

    await expect(homePage.root).toBeVisible();
    await expect(homePage.hero).toBeVisible();
    await expect(homePage.heading).toBeVisible();
    await expect(homePage.hero).toContainText("Launch campaigns with confidence");
    await expect(homePage.wizardCta).toBeVisible();
    await expect(homePage.wizardCta).toHaveAttribute("href", "/campaigns/create");
    await expect(homePage.highlights.getByRole("heading", { name: "Goal-first planning" })).toBeVisible();
    await expect(homePage.highlights.getByRole("heading", { name: "Audience clarity" })).toBeVisible();
    await expect(homePage.highlights.getByRole("heading", { name: "Launch review" })).toBeVisible();
  });
});
