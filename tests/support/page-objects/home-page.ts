import type { Locator, Page } from "@playwright/test";

export class HomePage {
  readonly root: Locator;
  readonly hero: Locator;
  readonly ctaGroup: Locator;
  readonly highlights: Locator;
  readonly heading: Locator;
  readonly workspaceCta: Locator;
  constructor(private readonly page: Page) {
    this.root = page.getByTestId("marketing-home");
    this.hero = page.getByTestId("marketing-hero");
    this.ctaGroup = page.getByTestId("marketing-cta");
    this.highlights = page.getByTestId("homepage-highlights");
    this.heading = this.hero.getByRole("heading", { level: 1 });
    this.workspaceCta = this.ctaGroup.getByRole("link", { name: "Enter your workspace" });
  }
  async visit() { await this.page.goto("/"); }
}
