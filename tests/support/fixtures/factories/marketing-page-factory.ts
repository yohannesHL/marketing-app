import { faker } from "@faker-js/faker";

import type { FactoryTracker } from "../types";

export type MarketingPageSeed = {
  campaignId: string;
  campaignName: string;
  eyebrow: string;
  headline: string;
  body: string;
  primaryCtaLabel: string;
  secondaryCtaLabel: string;
  brand: "launchpad" | "summit";
  theme: "light" | "dark";
};

export function createMarketingPageSeed(
  tracker: FactoryTracker,
  overrides: Partial<MarketingPageSeed> = {},
): MarketingPageSeed {
  const seed: MarketingPageSeed = {
    campaignId: faker.string.uuid(),
    campaignName: faker.company.name(),
    eyebrow: "Launchpad UI",
    headline: "Shared tokens, primitives, and composition rules for product and marketing work.",
    body: faker.lorem.sentence(),
    primaryCtaLabel: "Explore components",
    secondaryCtaLabel: "Open Storybook",
    brand: faker.helpers.arrayElement(["launchpad", "summit"]),
    theme: faker.helpers.arrayElement(["light", "dark"]),
    ...overrides,
  };

  tracker.register({
    id: seed.campaignId,
    type: "campaign",
  });

  return seed;
}
