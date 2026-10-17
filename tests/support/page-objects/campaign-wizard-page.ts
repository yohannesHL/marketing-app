import { expect, type Locator, type Page } from "@playwright/test";

export class CampaignWizardPage {
  readonly root: Locator;
  readonly stepTitle: Locator;
  readonly continueButton: Locator;
  readonly backButton: Locator;
  constructor(readonly page: Page) {
    this.root = page.getByTestId("unified-campaign-builder");
    this.stepTitle = page.locator("#builder-step-heading");
    this.continueButton = this.root.getByRole("button", { name: "Save & continue", exact: true });
    this.backButton = this.root.getByRole("button", { name: "Back", exact: true });
  }
  async visit(query = "") { await this.page.goto(`/campaigns/create${query}`); await expect(this.root).toBeVisible(); }
  async chooseType(label: "Social campaign" | "Paid advertising" | "Email campaign" | "Content / blog") {
    await this.root.getByRole("radio", { name: new RegExp(label.replace("/", "\\/")) }).check();
  }
  async fillBrief(name: string, brief = "Introduce our autumn collection to returning customers and invite them to explore the range.") {
    await this.root.getByLabel("Campaign name", { exact: true }).fill(name);
    await this.root.getByLabel("Website or product URL").fill("https://example.test/collection");
    await this.root.getByLabel("Campaign brief").fill(brief);
  }
  async fillAudience() {
    await this.root.getByLabel("Primary objective").selectOption("traffic");
    await this.root.getByLabel("Audience description").fill("Returning customers in London who enjoy independent design.");
  }
  async continueToNextStep() {
    const previous = await this.stepTitle.textContent();
    await this.continueButton.click();
    await expect(this.stepTitle).not.toHaveText(previous || "");
  }
  async goBack() { await this.backButton.click(); }
  async generateCreatives() {
    const response = this.page.waitForResponse(response => new URL(response.url()).pathname === "/api/workspace/assist" && response.request().method() === "POST");
    await this.root.getByRole("button", { name: "Generate drafts", exact: true }).click();
    await response;
  }
  async chooseChannel(label: string) { await this.root.getByRole("checkbox", { name: new RegExp(`^${label}`) }).check(); }
  campaignId() { const id = new URL(this.page.url()).searchParams.get("id"); if (!id) throw new Error("Campaign has not been saved"); return id; }
}
