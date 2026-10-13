import { expect, mergeTests, test as base } from "@playwright/test";

import { buildAnonymousSession, type AuthSession } from "../helpers/auth";
import { CampaignWizardPage } from "../page-objects/campaign-wizard-page";
import { HomePage } from "../page-objects/home-page";
import { createCampaignWizardSeed, type CampaignWizardSeed } from "./factories/campaign-wizard-factory";
import { createMarketingPageSeed, type MarketingPageSeed } from "./factories/marketing-page-factory";
import type { FactoryTracker, TrackedEntity } from "./types";

type FrameworkFixtures = {
  authSession: AuthSession;
  campaignWizardPage: CampaignWizardPage;
  campaignWizardSeed: CampaignWizardSeed;
  factoryTracker: FactoryTracker;
  homePage: HomePage;
  marketingPageSeed: MarketingPageSeed;
};

const frameworkFixtures = base.extend<FrameworkFixtures>({
  authSession: async ({}, use) => {
    await use(buildAnonymousSession());
  },
  factoryTracker: async ({}, use) => {
    const trackedEntities: TrackedEntity[] = [];

    const tracker: FactoryTracker = {
      register(entity) {
        trackedEntities.push(entity);
        return entity;
      },
      snapshot() {
        return [...trackedEntities];
      },
      async cleanup() {
        for (const entity of [...trackedEntities].reverse()) {
          await entity.cleanup?.();
        }
        trackedEntities.length = 0;
      },
    };

    await use(tracker);
    await tracker.cleanup();
  },
  homePage: async ({ page }, use) => {
    await use(new HomePage(page));
  },
  campaignWizardPage: async ({ page }, use) => {
    await use(new CampaignWizardPage(page));
  },
  campaignWizardSeed: async ({ factoryTracker }, use) => {
    await use(createCampaignWizardSeed(factoryTracker));
  },
  marketingPageSeed: async ({ factoryTracker }, use) => {
    await use(createMarketingPageSeed(factoryTracker));
  },
});

export const test = mergeTests(base, frameworkFixtures);
export { expect };
