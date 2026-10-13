import type {
  CampaignGoal,
  GoalStrategyResponse,
  LaunchCampaignResponse,
  SupportedPlatform,
} from "@launchpad/core";

type GoalReference = GoalStrategyResponse & {
  audienceFactor: number;
  recommendedBudgetFloor: number;
  reachMultiplier: number;
  platformWeight: Record<SupportedPlatform, number>;
  creativeAngle: string;
};

const goalReferenceByGoal: Record<CampaignGoal, GoalReference> = {
  "Product Launch": {
    goal: "Product Launch",
    headline: "Strategy guidance",
    recommendedObjective: "Build momentum quickly with clear value messaging and launch-week urgency.",
    guidance: [
      "Focus messaging on differentiators, launch timing, and the audience segments most likely to convert first.",
      "Pair a higher-intent channel mix with stronger budget concentration during the earliest launch window.",
      "Keep previews and creative variations aligned so teams can compare placements before going live.",
    ],
    audienceFactor: 0.86,
    recommendedBudgetFloor: 3200,
    reachMultiplier: 118,
    platformWeight: {
      Google: 1.22,
      Meta: 1.15,
      LinkedIn: 0.88,
      TikTok: 0.81,
      X: 0.64,
      Reddit: 0.58,
    },
    creativeAngle: "launch confidence",
  },
  "Brand Awareness": {
    goal: "Brand Awareness",
    headline: "Strategy guidance",
    recommendedObjective: "Prioritize broad but still relevant reach with memorable creative repetition.",
    guidance: [
      "Use accessible messaging that reinforces brand recognition before you optimize for downstream actions.",
      "Favor platforms that can deliver repeated exposure while preserving creative consistency.",
      "Anchor previews around a simple brand promise so each placement feels cohesive.",
    ],
    audienceFactor: 1.05,
    recommendedBudgetFloor: 2600,
    reachMultiplier: 142,
    platformWeight: {
      Google: 0.9,
      Meta: 1.2,
      LinkedIn: 0.74,
      TikTok: 1.08,
      X: 0.7,
      Reddit: 0.66,
    },
    creativeAngle: "brand recall",
  },
  "Lead Generation": {
    goal: "Lead Generation",
    headline: "Strategy guidance",
    recommendedObjective: "Balance clarity and proof so the audience can move from curiosity to conversion.",
    guidance: [
      "Lead with a tangible value exchange and a clear next step for qualified prospects.",
      "Keep targeting tight enough to preserve efficiency but broad enough to maintain lead volume.",
      "Use preview surfaces to confirm the offer stays visible even on smaller placements.",
    ],
    audienceFactor: 0.78,
    recommendedBudgetFloor: 2800,
    reachMultiplier: 104,
    platformWeight: {
      Google: 1.12,
      Meta: 0.94,
      LinkedIn: 1.06,
      TikTok: 0.68,
      X: 0.59,
      Reddit: 0.61,
    },
    creativeAngle: "qualified pipeline",
  },
  Traffic: {
    goal: "Traffic",
    headline: "Strategy guidance",
    recommendedObjective: "Optimize for efficient clicks with concise messaging and low-friction offers.",
    guidance: [
      "Use direct calls to action and simplify the first message the audience sees.",
      "Maintain enough reach to support learning while keeping budget disciplined across channels.",
      "Compare platform estimates before launch so the click-oriented mix stays intentional.",
    ],
    audienceFactor: 0.94,
    recommendedBudgetFloor: 2200,
    reachMultiplier: 130,
    platformWeight: {
      Google: 1.18,
      Meta: 0.97,
      LinkedIn: 0.71,
      TikTok: 0.89,
      X: 0.66,
      Reddit: 0.72,
    },
    creativeAngle: "efficient acquisition",
  },
};

const launchReceipts = new Map<string, LaunchCampaignResponse>();

export function getGoalReference(goal: CampaignGoal): GoalReference {
  return goalReferenceByGoal[goal];
}

export function listSupportedPlatformWeights(goal: CampaignGoal): Record<SupportedPlatform, number> {
  return goalReferenceByGoal[goal].platformWeight;
}

export function getCreativeAngle(goal: CampaignGoal): string {
  return goalReferenceByGoal[goal].creativeAngle;
}

export function saveLaunchReceipt(receipt: LaunchCampaignResponse): LaunchCampaignResponse {
  launchReceipts.set(receipt.launchId, receipt);
  return receipt;
}
