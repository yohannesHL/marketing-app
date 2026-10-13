import type {
  AudienceEstimateResponse,
  AudienceTargetingInput,
  BudgetPlanInput,
  BudgetRecommendationResponse,
  CampaignGoal,
  CreativeSuggestionsResponse,
  GoalStrategyResponse,
  LaunchCampaignRequest,
  PlacementPreview,
  PlatformEstimateResponse,
  SupportedPlatform,
  TargetGender,
} from "@launchpad/core";

export type GoalSelection = CampaignGoal | "";
export type GenderSelection = TargetGender | "All" | "";

export type AudienceFormState = {
  location: string;
  gender: GenderSelection;
  minAge: string;
  maxAge: string;
  interests: string;
  industry: string;
  jobTitles: string;
  customAudienceFileName?: string | null;
};

export type BudgetFormState = {
  dailyBudget: string;
  durationInDays: string;
  totalBudget: string;
};

export type SingleCreative = {
  id: string;
  headline: string;
  description: string;
  body: string;
  cta: string;
};

export type CreativeFormState = {
  creatives: SingleCreative[];
};

export type CampaignWizardFormState = {
  campaignName: string;
  goal: GoalSelection;
  audience: AudienceFormState;
  budget: BudgetFormState;
  creatives: CreativeFormState;
  selectedPlatforms: SupportedPlatform[];
};

export type WizardAsyncState = {
  goalStrategy: GoalStrategyResponse | null;
  goalStrategyError: string | null;
  audienceEstimate: AudienceEstimateResponse | null;
  audienceEstimateError: string | null;
  budgetInsight: BudgetRecommendationResponse | null;
  budgetInsightError: string | null;
  platformEstimate: PlatformEstimateResponse | null;
  platformEstimateError: string | null;
  creativeError: string | null;
  launchError: string | null;
  launchResult: {
    message: string;
    launchId: string;
    uniformPayload: boolean;
    platformsInvoked: string[];
  } | null;
};

export const genderOptions = [
  { label: "All", value: "All" },
  { label: "Women", value: "Women" },
  { label: "Men", value: "Men" },
  { label: "Non-binary", value: "Non-binary" },
];

const previewPlatforms = ["Facebook", "Google", "LinkedIn"] as const;

function generateCreativeId(): string {
  return `creative-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export function createEmptyCreative(): SingleCreative {
  return {
    id: generateCreativeId(),
    headline: "",
    description: "",
    body: "",
    cta: "",
  };
}

export const initialCampaignWizardFormState: CampaignWizardFormState = {
  campaignName: "",
  goal: "",
  audience: {
    location: "",
    gender: "All",
    minAge: "18",
    maxAge: "65",
    interests: "",
    industry: "",
    jobTitles: "",
    customAudienceFileName: null,
  },
  budget: {
    dailyBudget: "",
    durationInDays: "14",
    totalBudget: "",
  },
  creatives: {
    creatives: [createEmptyCreative()],
  },
  selectedPlatforms: [],
};

export const initialWizardAsyncState: WizardAsyncState = {
  goalStrategy: null,
  goalStrategyError: null,
  audienceEstimate: null,
  audienceEstimateError: null,
  budgetInsight: null,
  budgetInsightError: null,
  platformEstimate: null,
  platformEstimateError: null,
  creativeError: null,
  launchError: null,
  launchResult: null,
};

export function hasStepOneReady(goal: GoalSelection): goal is CampaignGoal {
  return goal !== "";
}

export function hasValidAudienceForEstimate(
  form: CampaignWizardFormState,
): form is CampaignWizardFormState & { goal: CampaignGoal } {
  return (
    hasStepOneReady(form.goal) &&
    form.audience.location.trim().length > 0 &&
    form.audience.gender !== ""
  );
}

export function hasValidBudgetPlan(
  form: CampaignWizardFormState,
): form is CampaignWizardFormState & { goal: CampaignGoal } {
  return (
    hasStepOneReady(form.goal) &&
    toBudgetPlanInput(form.goal, form.budget) !== null
  );
}

export function hasGeneratedCreatives(creatives: CreativeFormState): boolean {
  return (
    creatives.creatives.length > 0 &&
    creatives.creatives.some(
      (c) => c.headline.trim().length > 0 || c.description.trim().length > 0,
    )
  );
}

export function toAudienceTargetingInput(
  audience: AudienceFormState,
): AudienceTargetingInput | null {
  if (audience.location.trim().length === 0) {
    return null;
  }

  const ageRange =
    audience.minAge && audience.maxAge
      ? `${audience.minAge}-${audience.maxAge}`
      : "";

  const gender: TargetGender =
    audience.gender === "All" || audience.gender === ""
      ? "Any"
      : (audience.gender as TargetGender);

  return {
    location: audience.location,
    ageRange,
    gender,
    interests: audience.interests,
    industry: audience.industry,
    jobTitles: audience.jobTitles,
    customAudienceFileName: audience.customAudienceFileName ?? null,
  };
}

export function toBudgetPlanInput(
  goal: CampaignGoal,
  budget: BudgetFormState,
): BudgetPlanInput | null {
  const dailyBudget = parsePositiveInteger(budget.dailyBudget);
  const durationInDays = parsePositiveInteger(budget.durationInDays);
  const totalBudget = parsePositiveInteger(budget.totalBudget);

  if (dailyBudget === null || durationInDays === null || totalBudget === null) {
    return null;
  }

  return {
    goal,
    dailyBudget,
    durationInDays,
    totalBudget,
  };
}

export function toCreativeResponse(
  creatives: CreativeFormState,
): CreativeSuggestionsResponse {
  const previews = createPlacementPreviews(creatives);
  const allCreatives = creatives.creatives;

  return {
    headlines: allCreatives.map((c) => c.headline).filter(Boolean),
    descriptions: allCreatives.map((c) => c.description).filter(Boolean),
    adCopy: allCreatives.map((c) => c.body).filter(Boolean),
    imageAds: [],
    videoAds: [],
    carouselAds: [],
    previews,
  };
}

export function createLaunchCampaignRequest(
  form: CampaignWizardFormState,
): LaunchCampaignRequest | null {
  if (!hasStepOneReady(form.goal)) {
    return null;
  }

  const audience = toAudienceTargetingInput(form.audience);
  const budget = toBudgetPlanInput(form.goal, form.budget);

  if (
    audience === null ||
    budget === null ||
    form.selectedPlatforms.length === 0 ||
    !hasGeneratedCreatives(form.creatives)
  ) {
    return null;
  }

  return {
    goal: form.goal,
    audience,
    budget,
    creatives: toCreativeResponse(form.creatives),
    selectedPlatforms: form.selectedPlatforms,
  };
}

export function createPlacementPreviews(
  creatives: CreativeFormState,
): PlacementPreview[] {
  const firstCreative = creatives.creatives[0];

  return previewPlatforms.map((platform) => ({
    platform,
    headline: firstCreative?.headline || "Preview headline",
    description: firstCreative?.description || "Preview description",
    body: firstCreative?.body || "Preview body copy",
    callToAction:
      firstCreative?.cta ||
      (platform === "LinkedIn" ? "Book a demo" : "Learn more"),
  }));
}

export function mapCreativeResponseToForm(
  response: CreativeSuggestionsResponse,
): CreativeFormState {
  const creatives: SingleCreative[] = response.headlines.map(
    (headline, index) => ({
      id: generateCreativeId(),
      headline,
      description: response.descriptions[index] || "",
      body: response.adCopy[index] || "",
      cta: "Learn More",
    }),
  );

  return {
    creatives: creatives.length > 0 ? creatives : [createEmptyCreative()],
  };
}

export function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

export function splitMultilineValue(value: string): string[] {
  return value
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parsePositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }

  const parsedValue = Number.parseInt(value, 10);
  return parsedValue > 0 ? parsedValue : null;
}
