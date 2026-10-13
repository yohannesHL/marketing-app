import type { FactoryTracker } from "../types";

export type CampaignWizardSeed = {
  goal: "Product Launch" | "Brand Awareness" | "Lead Generation" | "Traffic";
  location: string;
  ageRange: string;
  gender: "Any" | "Women" | "Men" | "Non-binary";
  interests: string;
  industry: string;
  jobTitles: string;
  dailyBudget: string;
  durationInDays: string;
  totalBudget: string;
  editedHeadline: string;
  editedDescription: string;
  editedAdCopy: string;
  selectedPlatforms: Array<"Google" | "Meta" | "LinkedIn" | "TikTok" | "X" | "Reddit">;
  customAudienceFileName: string;
  customAudienceContents: string;
  invalidAudienceFileName: string;
  invalidAudienceContents: string;
};

export function createCampaignWizardSeed(
  tracker: FactoryTracker,
  overrides: Partial<CampaignWizardSeed> = {},
): CampaignWizardSeed {
  const seed: CampaignWizardSeed = {
    goal: "Product Launch",
    location: "United States",
    ageRange: "25-34",
    gender: "Any",
    interests: "Product marketing, lifecycle campaigns, growth strategy",
    industry: "Software",
    jobTitles: "Marketing Director, Growth Manager, Demand Generation Lead",
    dailyBudget: "250",
    durationInDays: "14",
    totalBudget: "3500",
    editedHeadline: "Launch faster with a campaign plan your team can trust",
    editedDescription: "Shape audience targeting, budgets, and channel mix before you go live.",
    editedAdCopy: "Turn your next release into a measurable launch with clear strategy guidance and confident creative.",
    selectedPlatforms: ["Google", "Meta", "LinkedIn"],
    customAudienceFileName: "launch-audience.csv",
    customAudienceContents: "email\nalex@example.com\nmorgan@example.com\n",
    invalidAudienceFileName: "launch-audience.pdf",
    invalidAudienceContents: "%PDF-1.4",
    ...overrides,
  };

  tracker.register({
    id: `${seed.goal}-${seed.location}`.toLowerCase().replace(/\s+/g, "-"),
    type: "campaign",
  });

  return seed;
}
