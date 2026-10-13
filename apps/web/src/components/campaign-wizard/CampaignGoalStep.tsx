"use client";

import {
  campaignGoals,
  type CampaignGoal,
  type GoalStrategyResponse,
} from "@launchpad/core";
import { Grid, Input, SelectableCard, Stack, Typography } from "@launchpad/ui";

import type { GoalSelection } from "./state";

const goalIcons: Record<CampaignGoal, string> = {
  "Product Launch": "🚀",
  "Brand Awareness": "🌟",
  "Lead Generation": "🎯",
  Traffic: "🌐",
};

const goalDescriptions: Record<CampaignGoal, string> = {
  "Product Launch": "Create buzz around your new product",
  "Brand Awareness": "Get your brand in front of the right people",
  "Lead Generation": "Capture leads and grow your pipeline",
  Traffic: "Drive visitors to your website",
};

const goalRecommendations: Record<CampaignGoal, string> = {
  "Product Launch": "Recommended: Multi-platform launch with video content",
  "Brand Awareness": "Recommended: Display and social campaigns",
  "Lead Generation": "Recommended: LinkedIn and Google lead forms",
  Traffic: "Recommended: CPC-optimized campaigns across platforms",
};

type CampaignGoalStepProps = {
  campaignName: string;
  goal: GoalSelection;
  goalStrategy: GoalStrategyResponse | null;
  isLoading: boolean;
  error: string | null;
  onCampaignNameChange: (name: string) => void;
  onGoalChange: (goal: CampaignGoal) => void;
};

export function CampaignGoalStep({
  campaignName,
  goal,
  goalStrategy,
  isLoading,
  error,
  onCampaignNameChange,
  onGoalChange,
}: CampaignGoalStepProps) {
  return (
    <Stack gap={8}>
      <Input
        label="Campaign Name"
        placeholder="My awesome campaign"
        value={campaignName}
        onChange={(e) => onCampaignNameChange(e.target.value)}
      />

      <div>
        <Typography variant="heading-3" className="mb-2">
          Campaign Goal
        </Typography>
        <Typography tone="muted" className="mb-6">
          What do you want to achieve?
        </Typography>

        <Grid minItemWidth="16rem">
          {campaignGoals.map((campaignGoal) => (
            <SelectableCard
              key={campaignGoal}
              icon={goalIcons[campaignGoal]}
              title={campaignGoal}
              description={goalDescriptions[campaignGoal]}
              selected={goal === campaignGoal}
              recommendation={goalRecommendations[campaignGoal]}
              onSelect={() => onGoalChange(campaignGoal)}
            />
          ))}
        </Grid>
      </div>
    </Stack>
  );
}
