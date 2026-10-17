import { test, expect } from "../support/fixtures";
import { runWithDocumentResponse, waitForNoPageErrors } from "../support/helpers/network";

test.describe("public product landing page", () => {
  test("anonymous visitors see the product story and a workspace entry point", async ({ page, authSession, homePage }) => {
    expect(authSession.strategy).toBe("anonymous");
    await runWithDocumentResponse(page, () => homePage.visit(), "/");
    await waitForNoPageErrors(page);
    await expect(homePage.root).toBeVisible();
    await expect(homePage.heading).toContainText("Your next idea.");
    await expect(homePage.heading).toContainText("great campaign.");
    await expect(homePage.workspaceCta).toHaveAttribute("href", "/dashboard");
    await expect(homePage.highlights.getByRole("heading", { name: "Give your campaign a direction" })).toBeVisible();
    await expect(homePage.highlights.getByRole("heading", { name: "Make it right for each channel" })).toBeVisible();
    await expect(homePage.highlights.getByRole("heading", { name: "Review once. Keep moving." })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Global navigation", exact: true })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Product navigation" }).getByRole("link", { name: "Sign in", exact: true })).toHaveAttribute("href", "/sign-in");
  });

  test("workspace entry requires a session and preserves the dashboard destination", async ({ page, homePage }) => {
    await homePage.visit();
    await homePage.workspaceCta.click();
    await expect(page).toHaveURL(/\/sign-in\?returnTo=%2Fdashboard$/);
    await expect(page.getByLabel(/^Email/)).toBeVisible();
    await expect(page.getByLabel(/^Password/)).toBeVisible();
  });
});
