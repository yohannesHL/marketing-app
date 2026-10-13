import {
  isCampaignGoal,
  isSupportedPlatform,
  isTargetGender,
  type AudienceBand,
  type AudienceEstimateRequest,
  type AudienceEstimateResponse,
  type AudienceTargetingInput,
  type BudgetPlanInput,
  type BudgetRecommendationResponse,
  type CampaignGoal,
  type CreativeSuggestionsRequest,
  type CreativeSuggestionsResponse,
  type LaunchCampaignRequest,
  type LaunchCampaignResponse,
  type PlatformEstimateRequest,
  type PlatformEstimateResponse,
  type SupportedPlatform,
} from "@launchpad/core";

import {
  getCreativeAngle,
  getGoalReference,
  listSupportedPlatformWeights,
  saveLaunchReceipt,
} from "../repositories/campaignWizardRepository";

const previewPlatforms = ["Facebook", "Google", "LinkedIn"] as const;

export function getGoalStrategy(goal: CampaignGoal) {
  return getGoalReference(goal);
}

export function calculateAudienceEstimate(request: AudienceEstimateRequest): AudienceEstimateResponse {
  const { targeting } = request;
  const goalReference = getGoalReference(request.goal);
  const interestsCount = splitList(targeting.interests).length;
  const titlesCount = splitList(targeting.jobTitles).length;
  const baseEstimate = 210_000 * goalReference.audienceFactor;
  const locationFactor = targeting.location.trim() ? 0.72 : 1;
  const ageFactor = targeting.ageRange.trim() ? 0.84 : 1;
  const genderFactor = targeting.gender === "Any" ? 1 : 0.82;
  const industryFactor = targeting.industry.trim() ? 0.68 : 1;
  const interestsFactor = Math.max(0.48, 1 - interestsCount * 0.09);
  const titlesFactor = Math.max(0.52, 1 - titlesCount * 0.08);
  const customAudienceBoost = targeting.customAudienceFileName ? 1.12 : 1;
  const estimatedSize = Math.max(
    4_200,
    Math.round(
      baseEstimate
        * locationFactor
        * ageFactor
        * genderFactor
        * industryFactor
        * interestsFactor
        * titlesFactor
        * customAudienceBoost,
    ),
  );

  return {
    estimatedSize,
    indicatorValue: Math.min(100, Math.max(8, Math.round((estimatedSize / 150_000) * 100))),
    band: getAudienceBand(estimatedSize),
    summary: `${estimatedSize.toLocaleString()} people estimated in a ${getAudienceBand(estimatedSize).toLowerCase()} audience.`,
  };
}

export function calculateBudgetRecommendation(plan: BudgetPlanInput): BudgetRecommendationResponse {
  const goalReference = getGoalReference(plan.goal);
  const recommendedBudget = Math.max(goalReference.recommendedBudgetFloor, Math.round(plan.dailyBudget * Math.min(plan.durationInDays, 21)));
  const estimatedReach = Math.round(plan.totalBudget * goalReference.reachMultiplier);

  return {
    recommendedBudget,
    estimatedReach,
    summary: `A ${plan.durationInDays}-day ${plan.goal.toLowerCase()} plan at $${plan.dailyBudget}/day is projected to reach about ${estimatedReach.toLocaleString()} people.`,
  };
}

export function generateCreativeSuggestions(request: CreativeSuggestionsRequest): CreativeSuggestionsResponse {
  const creativeAngle = getCreativeAngle(request.goal);
  const audienceFocus = request.audience.industry.trim() || "high-intent teams";
  const hook = request.audience.location.trim() || "your market";
  const dailyBudget = `$${request.budget.dailyBudget}/day`;

  const headlines = [
    `${request.goal} built for ${audienceFocus}`,
    `Move from planning to launch with ${creativeAngle}`,
    `A clearer campaign path for ${hook}`,
  ];
  const descriptions = [
    `Align targeting, budget, and channels before launch with a workflow tailored for ${request.goal.toLowerCase()}.`,
    `Give ${audienceFocus.toLowerCase()} a confident first impression with guided strategy and editable creative.`,
    `Turn launch planning into a repeatable process with transparent estimates and review-ready assets.`,
  ];
  const adCopy = [
    `Create a launch-ready campaign with guidance that keeps audience, budget, and placements aligned at ${dailyBudget}.`,
    `Use AI-assisted creative suggestions to shape a sharper message for ${hook} without losing control before launch.`,
  ];
  const imageAds = [
    `Static product hero with launch milestone banner for ${hook}.`,
    `Audience proof card highlighting outcomes for ${audienceFocus.toLowerCase()}.`,
  ];
  const videoAds = [
    `15-second launch teaser that introduces the main value proposition and ends with a direct CTA.`,
    `Short explainer cut showing the campaign journey from strategy to launch confirmation.`,
  ];
  const carouselAds = [
    `Card 1: launch challenge, Card 2: audience strategy, Card 3: budget clarity, Card 4: confident launch.`,
    `Card 1: product value, Card 2: ideal audience, Card 3: platform fit, Card 4: call to action.`,
  ];

  const primaryHeadline = headlines[0];
  const primaryDescription = descriptions[0];
  const primaryBody = adCopy[0];

  return {
    headlines,
    descriptions,
    adCopy,
    imageAds,
    videoAds,
    carouselAds,
    previews: previewPlatforms.map((platform) => ({
      platform,
      headline: primaryHeadline,
      description: primaryDescription,
      body: primaryBody,
      callToAction: platform === "LinkedIn" ? "Book a demo" : "Learn more",
    })),
  };
}

export function calculatePlatformEstimates(request: PlatformEstimateRequest): PlatformEstimateResponse {
  const platformWeights = listSupportedPlatformWeights(request.goal);
  const platforms = request.selectedPlatforms.map((platform) => {
    const estimatedTraffic = Math.max(18, Math.round((request.totalBudget / 10) * platformWeights[platform]));

    return {
      platform,
      estimatedTraffic,
      rationale: `${platform} is weighted for ${request.goal.toLowerCase()} campaigns with the current budget level.`,
    };
  });

  return {
    platforms,
    summary: `${request.selectedPlatforms.length} platform${request.selectedPlatforms.length === 1 ? "" : "s"} selected with ${platforms
      .reduce((sum, platform) => sum + platform.estimatedTraffic, 0)
      .toLocaleString()} estimated visits.`,
  };
}

export function launchCampaign(request: LaunchCampaignRequest): LaunchCampaignResponse {
  const launchId = `launch-${Date.now().toString(36)}`;

  return saveLaunchReceipt({
    launchId,
    status: "queued",
    message: "Campaign launch queued. Review checkpoints passed and the workflow is ready for downstream orchestration.",
    launchedPlatforms: request.selectedPlatforms,
  });
}

export function parseGoal(value: unknown): CampaignGoal | null {
  return typeof value === "string" && isCampaignGoal(value) ? value : null;
}

export function parseString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function parsePositiveNumber(value: unknown): number | null {
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
    return null;
  }

  return value;
}

export function parseTargeting(value: unknown): AudienceTargetingInput | null {
  if (!isRecord(value)) {
    return null;
  }

  const location = parseString(value.location);
  const ageRange = parseString(value.ageRange);
  const gender = parseString(value.gender);
  const interests = parseString(value.interests);
  const industry = parseString(value.industry);
  const jobTitles = parseString(value.jobTitles);
  const customAudienceFileName =
    value.customAudienceFileName === null || value.customAudienceFileName === undefined
      ? null
      : parseString(value.customAudienceFileName);

  if (
    location === null ||
    ageRange === null ||
    gender === null ||
    interests === null ||
    industry === null ||
    jobTitles === null ||
    !isTargetGender(gender)
  ) {
    return null;
  }

  return {
    location,
    ageRange,
    gender,
    interests,
    industry,
    jobTitles,
    customAudienceFileName,
  };
}

export function parseBudgetPlan(value: unknown): BudgetPlanInput | null {
  if (!isRecord(value)) {
    return null;
  }

  const goal = parseGoal(value.goal);
  const dailyBudget = parsePositiveNumber(value.dailyBudget);
  const durationInDays = parsePositiveNumber(value.durationInDays);
  const totalBudget = parsePositiveNumber(value.totalBudget);

  if (goal === null || dailyBudget === null || durationInDays === null || totalBudget === null) {
    return null;
  }

  return {
    goal,
    dailyBudget,
    durationInDays,
    totalBudget,
  };
}

export function parseSelectedPlatforms(value: unknown): SupportedPlatform[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const platforms = value.filter((entry): entry is string => typeof entry === "string");

  if (platforms.length !== value.length || platforms.some((entry) => !isSupportedPlatform(entry))) {
    return null;
  }

  return platforms.filter((entry): entry is SupportedPlatform => isSupportedPlatform(entry));
}

export function parseCreativeSuggestions(value: unknown): CreativeSuggestionsResponse | null {
  if (!isRecord(value)) {
    return null;
  }

  const headlines = parseStringArray(value.headlines);
  const descriptions = parseStringArray(value.descriptions);
  const adCopy = parseStringArray(value.adCopy);
  const imageAds = parseStringArray(value.imageAds);
  const videoAds = parseStringArray(value.videoAds);
  const carouselAds = parseStringArray(value.carouselAds);
  const previews = Array.isArray(value.previews) ? value.previews : null;

  if (
    headlines === null ||
    descriptions === null ||
    adCopy === null ||
    imageAds === null ||
    videoAds === null ||
    carouselAds === null ||
    previews === null
  ) {
    return null;
  }

  const parsedPreviews = previews
    .map((preview) => {
      if (!isRecord(preview)) {
        return null;
      }

      const platform = parseString(preview.platform);
      const headline = parseString(preview.headline);
      const description = parseString(preview.description);
      const body = parseString(preview.body);
      const callToAction = parseString(preview.callToAction);

      if (
        platform === null ||
        headline === null ||
        description === null ||
        body === null ||
        callToAction === null ||
        !["Facebook", "Google", "LinkedIn"].includes(platform)
      ) {
        return null;
      }

      return {
        platform: platform as "Facebook" | "Google" | "LinkedIn",
        headline,
        description,
        body,
        callToAction,
      };
    })
    .filter((preview) => preview !== null);

  if (parsedPreviews.length !== previews.length) {
    return null;
  }

  return {
    headlines,
    descriptions,
    adCopy,
    imageAds,
    videoAds,
    carouselAds,
    previews: parsedPreviews,
  };
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return null;
  }

  return value;
}

function getAudienceBand(estimatedSize: number): AudienceBand {
  if (estimatedSize < 28_000) {
    return "Niche";
  }

  if (estimatedSize < 80_000) {
    return "Balanced";
  }

  return "Broad";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
