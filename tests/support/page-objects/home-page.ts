import type { Locator, Page } from "@playwright/test";

export class HomePage {
  readonly root: Locator;
  readonly hero: Locator;
  readonly ctaGroup: Locator;
  readonly highlights: Locator;
  readonly heading: Locator;
  readonly wizardCta: Locator;

  constructor(private readonly page: Page) {
    this.root = page.getByTestId("marketing-home");
    this.hero = page.getByTestId("marketing-hero");
    this.ctaGroup = page.getByTestId("marketing-cta");
    this.highlights = page.getByTestId("homepage-highlights");
    this.heading = page.getByRole("heading", {
      name: /launch campaigns with confidence/i,
    });
    this.wizardCta = page.getByRole("link", { name: "Open campaign wizard" });
  }

  async visit(): Promise<void> {
    await this.page.goto("/");
  }
}
