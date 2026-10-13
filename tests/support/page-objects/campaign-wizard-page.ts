import type { Locator, Page } from "@playwright/test";

import type { CampaignWizardSeed } from "../fixtures/factories/campaign-wizard-factory";

export class CampaignWizardPage {
  readonly page: Page;
  readonly root: Locator;
  readonly stepTitle: Locator;
  readonly continueButton: Locator;
  readonly backButton: Locator;
  readonly goalGuidance: Locator;
  readonly audienceEstimate: Locator;
  readonly budgetInsights: Locator;
  readonly creativeWorkspace: Locator;
  readonly platformInsights: Locator;
  readonly reviewSummary: Locator;
  readonly launchResult: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.getByTestId("campaign-wizard");
    this.stepTitle = page.getByTestId("campaign-step-title");
    this.continueButton = page.getByRole("button", { name: "Continue" });
    this.backButton = page.getByRole("button", { name: "Back" });
    this.goalGuidance = page.getByTestId("goal-guidance");
    this.audienceEstimate = page.getByTestId("audience-estimate");
    this.budgetInsights = page.getByTestId("budget-insights");
    this.creativeWorkspace = page.getByTestId("creative-workspace");
    this.platformInsights = page.getByTestId("platform-estimates");
    this.reviewSummary = page.getByTestId("launch-review");
    this.launchResult = page.getByTestId("launch-result");
  }

  async visit(): Promise<void> {
    await this.page.goto("/campaigns/create");
  }

  async chooseGoal(goal: CampaignWizardSeed["goal"]): Promise<void> {
    await this.page.getByLabel(goal).check();
  }

  async fillAudience(seed: CampaignWizardSeed): Promise<void> {
    await this.page.getByLabel("Location").fill(seed.location);
    await this.page.getByLabel("Age range").selectOption(seed.ageRange);
    await this.page.getByLabel("Gender").selectOption(seed.gender);
    await this.page.getByLabel("Interests").fill(seed.interests);
    await this.page.getByLabel("Industry").fill(seed.industry);
    await this.page.getByLabel("Job titles").fill(seed.jobTitles);
  }

  async uploadCustomAudience(fileName: string, contents: string, mimeType: string): Promise<void> {
    await this.page.getByLabel("Custom audience upload").setInputFiles({
      name: fileName,
      mimeType,
      buffer: Buffer.from(contents),
    });
  }

  async fillBudget(values: Pick<CampaignWizardSeed, "dailyBudget" | "durationInDays" | "totalBudget">): Promise<void> {
    await this.page.getByLabel("Daily budget").fill(values.dailyBudget);
    await this.page.getByLabel("Campaign duration").fill(values.durationInDays);
    await this.page.getByLabel("Total budget").fill(values.totalBudget);
  }

  async generateCreatives(): Promise<void> {
    await this.page.getByRole("button", { name: "Generate creatives" }).click();
  }

  async editGeneratedCreative(seed: CampaignWizardSeed): Promise<void> {
    await this.page.getByLabel("Headlines").fill(seed.editedHeadline);
    await this.page.getByLabel("Descriptions").fill(seed.editedDescription);
    await this.page.getByLabel("Ad copy").fill(seed.editedAdCopy);
  }

  async setPlatformSelection(platform: CampaignWizardSeed["selectedPlatforms"][number], enabled: boolean): Promise<void> {
    const control = this.page.getByLabel(platform);

    if (enabled) {
      await control.check();
      return;
    }

    await control.uncheck();
  }

  async continueToNextStep(): Promise<void> {
    await this.continueButton.click();
  }

  async goBack(): Promise<void> {
    await this.backButton.click();
  }
}
