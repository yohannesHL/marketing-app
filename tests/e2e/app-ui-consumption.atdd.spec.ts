import { expect, test } from "../support/fixtures";
import { signInTestCustomer } from "../support/helpers/customer-session";

test.describe("workspace structure and navigation", () => {
  test("signed-in customers have a campaign library, consistent navigation and honest future modules", async ({ page, request, context }, testInfo) => {
    await signInTestCustomer(request, testInfo.project.name, context, "wizard");
    await page.goto("/dashboard");
    const navigation = page.getByRole("navigation", { name: "Global navigation", exact: true });
    await expect(navigation).toBeVisible();
    for (const name of ["Home", "Campaigns", "Content Studio", "Social marketing"]) await expect(navigation.getByRole("link", { name, exact: true })).toBeVisible();
    for (const name of ["AI Copilot", "Workflows", "Affiliate marketing", "Analytics & insights"]) await expect(navigation.getByRole("button", { name: new RegExp(name) })).toBeDisabled();
    await navigation.getByRole("link", { name: "Campaigns", exact: true }).click();
    await expect(page).toHaveURL(/\/campaigns$/);
    await expect(navigation.getByRole("link", { name: "Campaigns", exact: true })).toHaveAttribute("aria-current", "page");
    await page.getByLabel("Search quick actions").fill("no-action-matches-this-query");
    await expect(page.getByText("No matching actions. Try “campaign” or “social”.")).toBeVisible();
    await page.getByLabel("Search quick actions").fill("Create a campaign");
    await page.locator("#quick-actions").getByRole("link", { name: /Create a campaign/ }).click();
    await expect(page.getByTestId("unified-campaign-builder")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Campaign creation progress" })).toBeVisible();
  });
});
