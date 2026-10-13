import type {
  AudienceEstimateRequest,
  AudienceEstimateResponse,
  BudgetPlanInput,
  BudgetRecommendationResponse,
  CampaignGoal,
  CampaignObjective,
  CreateCampaignInput,
  CreativeSuggestionsRequest,
  CreativeSuggestionsResponse,
  GoalStrategyResponse,
  PlatformEstimateRequest,
  PlatformEstimateResponse,
} from "@launchpad/core";

import type { CampaignWizardFormState } from "./state";

async function readJson<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as { message?: string };

  if (!response.ok) {
    throw new Error(payload.message ?? "The campaign wizard request failed.");
  }

  return payload as T;
}

export async function fetchGoalStrategy(
  goal: CampaignGoal,
): Promise<GoalStrategyResponse> {
  const response = await fetch(
    `/api/campaign-wizard/goal-strategy?goal=${encodeURIComponent(goal)}`,
  );
  return readJson<GoalStrategyResponse>(response);
}

export async function fetchAudienceEstimate(
  payload: AudienceEstimateRequest,
): Promise<AudienceEstimateResponse> {
  const response = await fetch("/api/campaign-wizard/audience-estimate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  return readJson<AudienceEstimateResponse>(response);
}

export async function fetchBudgetInsight(
  payload: BudgetPlanInput,
): Promise<BudgetRecommendationResponse> {
  const response = await fetch("/api/campaign-wizard/budget-plan", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  return readJson<BudgetRecommendationResponse>(response);
}

export async function fetchCreativeSuggestions(
  payload: CreativeSuggestionsRequest,
): Promise<CreativeSuggestionsResponse> {
  const response = await fetch("/api/campaign-wizard/creative-suggestions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  return readJson<CreativeSuggestionsResponse>(response);
}

export async function fetchPlatformEstimate(
  payload: PlatformEstimateRequest,
): Promise<PlatformEstimateResponse> {
  const response = await fetch("/api/campaign-wizard/platform-estimate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  return readJson<PlatformEstimateResponse>(response);
}

type AdsProxyLaunchResponse = {
  executionId: string;
  message: string;
  uniformPayload: boolean;
  platformsInvoked: string[];
};

type WizardLaunchResponse = {
  message: string;
  launchId: string;
  uniformPayload: boolean;
  platformsInvoked: string[];
};

function mapGoalToObjective(goal: CampaignGoal): CampaignObjective {
  switch (goal) {
    case "Brand Awareness":
      return "AWARENESS";
    case "Lead Generation":
      return "LEADS";
    case "Traffic":
      return "CLICKS";
    default:
      return "CONVERSIONS";
  }
}

function mapWizardPlatformsToProxyPlatforms(
  platforms: CampaignWizardFormState["selectedPlatforms"],
) {
  return platforms
    .map((platform) => {
      switch (platform) {
        case "Google":
          return "GOOGLE";
        case "Meta":
          return "META";
        case "TikTok":
          return "TIKTOK";
        default:
          return null;
      }
    })
    .filter(
      (platform): platform is "GOOGLE" | "META" | "TIKTOK" => platform !== null,
    );
}

function buildCreateCampaignPayload(
  form: CampaignWizardFormState,
): CreateCampaignInput {
  const campaignName = form.campaignName.trim() || `${form.goal} test campaign`;
  const dailyBudget = Number.parseInt(form.budget.dailyBudget, 10);
  const durationInDays = Number.parseInt(form.budget.durationInDays, 10);
  const totalBudget = Number.parseInt(form.budget.totalBudget, 10);
  const ageRange = [
    Number.parseInt(form.audience.minAge || "18", 10),
    Number.parseInt(form.audience.maxAge || "65", 10),
  ] as [number, number];

  const creatives = form.creatives.creatives
    .map((creative) => ({
      headline: creative.headline.trim() || undefined,
      description: creative.description.trim() || undefined,
      body: creative.body.trim() || undefined,
      cta: creative.cta.trim() || undefined,
    }))
    .filter((creative) =>
      Object.values(creative).some((value) => value !== undefined),
    );

  return {
    name: campaignName,
    campaignName,
    goal: form.goal || undefined,
    objective: mapGoalToObjective(form.goal as CampaignGoal),
    budget: {
      dailyBudget,
      currency: "USD",
      durationInDays: Number.isNaN(durationInDays) ? undefined : durationInDays,
      totalBudget: Number.isNaN(totalBudget) ? undefined : totalBudget,
    },
    targeting: {
      locations: form.audience.location
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
      ageRange,
      interests: form.audience.interests
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    },
    creatives,
    status: "PAUSED",
  };
}

export async function submitLaunchCampaign(
  form: CampaignWizardFormState,
): Promise<WizardLaunchResponse> {
  const response = await fetch("/api/ads/createCampaign", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      payload: buildCreateCampaignPayload(form),
      platforms: mapWizardPlatformsToProxyPlatforms(form.selectedPlatforms),
      source: "wizard-launch",
    }),
  });

  const payload = await readJson<AdsProxyLaunchResponse>(response);

  return {
    message: payload.message,
    launchId: payload.executionId,
    uniformPayload: payload.uniformPayload,
    platformsInvoked: payload.platformsInvoked,
  };
}
