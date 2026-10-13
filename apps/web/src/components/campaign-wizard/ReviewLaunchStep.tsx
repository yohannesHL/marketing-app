"use client";

import {
  Alert,
  Badge,
  Card,
  Grid,
  Icon,
  Stack,
  Typography,
} from "@launchpad/ui";

import type {
  AudienceEstimateResponse,
  BudgetRecommendationResponse,
  PlatformEstimateResponse,
  SupportedPlatform,
} from "@launchpad/core";

import { formatCurrency, type CampaignWizardFormState } from "./state";

const platformIcons: Record<SupportedPlatform | string, string> = {
  Meta: "📱",
  Google: "🔍",
  LinkedIn: "💼",
  TikTok: "🎵",
  X: "✖️",
  Reddit: "🔴",
  YouTube: "▶️",
};

type ReviewLaunchStepProps = {
  form: CampaignWizardFormState;
  audienceEstimate: AudienceEstimateResponse | null;
  budgetInsight: BudgetRecommendationResponse | null;
  platformEstimate: PlatformEstimateResponse | null;
  launchError: string | null;
  launchResult: {
    message: string;
    launchId: string;
    uniformPayload: boolean;
    platformsInvoked: string[];
  } | null;
  isLaunching: boolean;
  onLaunch: () => Promise<void>;
};

export function ReviewLaunchStep({
  form,
  audienceEstimate,
  budgetInsight,
  platformEstimate,
  launchError,
  launchResult,
  isLaunching,
  onLaunch,
}: ReviewLaunchStepProps) {
  const dailyBudget = form.budget.dailyBudget
    ? Number.parseInt(form.budget.dailyBudget, 10)
    : 0;
  const durationDays = form.budget.durationInDays
    ? Number.parseInt(form.budget.durationInDays, 10)
    : 14;
  const totalBudget = form.budget.totalBudget
    ? Number.parseInt(form.budget.totalBudget, 10)
    : dailyBudget * durationDays;

  return (
    <Stack gap={8}>
      <div>
        <Typography variant="heading-3" className="mb-2">
          Review & Launch
        </Typography>
        <Typography tone="muted">
          Review your plan before submitting the advertising demo.
        </Typography>
      </div>

      <div data-testid="launch-review">
        <Stack gap={4}>
          {/* Campaign Goal Card */}
          <Card>
            <div className="flex items-center gap-3 mb-3">
              <Icon size={20} className="text-primary">
                <circle cx="12" cy="12" r="10" />
                <circle cx="12" cy="12" r="3" />
              </Icon>
              <Typography className="font-semibold">Campaign Goal</Typography>
            </div>
            <Badge tone="neutral">{form.goal || "Not set"}</Badge>
          </Card>

          {/* Audience Card */}
          <Card>
            <div className="flex items-center gap-3 mb-3">
              <Icon size={20} className="text-primary">
                <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
              </Icon>
              <Typography className="font-semibold">Audience</Typography>
            </div>
            <Grid minItemWidth="10rem" className="mb-3">
              <div>
                <Typography tone="muted" className="text-xs">
                  Locations
                </Typography>
                <Typography>{form.audience.location || "All"}</Typography>
              </div>
              <div>
                <Typography tone="muted" className="text-xs">
                  Age
                </Typography>
                <Typography>
                  {form.audience.minAge || "18"} -{" "}
                  {form.audience.maxAge || "65"}
                </Typography>
              </div>
            </Grid>
            <div>
              <Typography tone="muted" className="text-xs mb-1">
                Interests
              </Typography>
              <Typography tone="muted">
                {form.audience.interests || "No specific interests"}
              </Typography>
            </div>
          </Card>

          {/* Budget Card */}
          <Card>
            <div className="flex items-center gap-3 mb-3">
              <Icon size={20} className="text-primary">
                <line x1="12" y1="1" x2="12" y2="23" />
                <path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
              </Icon>
              <Typography className="font-semibold">Budget</Typography>
            </div>
            <Grid minItemWidth="8rem">
              <div>
                <Typography tone="muted" className="text-xs">
                  Daily
                </Typography>
                <Typography>
                  {dailyBudget > 0 ? formatCurrency(dailyBudget) : "$0"}
                </Typography>
              </div>
              <div>
                <Typography tone="muted" className="text-xs">
                  Duration
                </Typography>
                <Typography>{durationDays} days</Typography>
              </div>
              <div>
                <Typography tone="muted" className="text-xs">
                  Total
                </Typography>
                <Typography className="text-primary font-semibold">
                  {totalBudget > 0 ? formatCurrency(totalBudget) : "$0"}
                </Typography>
              </div>
            </Grid>
          </Card>

          {/* Platforms Card */}
          <Card>
            <div className="flex items-center gap-3 mb-3">
              <Icon size={20} className="text-primary">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </Icon>
              <Typography className="font-semibold">
                Platforms ({form.selectedPlatforms.length})
              </Typography>
            </div>
            <div className="flex flex-wrap gap-2">
              {form.selectedPlatforms.map((platform) => (
                <Badge
                  key={platform}
                  tone="neutral"
                  className="flex items-center gap-1"
                >
                  <span>{platformIcons[platform]}</span>
                  <span>{platform}</span>
                </Badge>
              ))}
              {form.selectedPlatforms.length === 0 && (
                <Typography tone="muted">No platforms selected</Typography>
              )}
            </div>
          </Card>

          {/* Creatives Card */}
          <Card>
            <div className="flex items-center gap-3 mb-3">
              <Icon size={20} className="text-primary">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </Icon>
              <Typography className="font-semibold">
                Creatives ({form.creatives.creatives.length})
              </Typography>
            </div>
            <Stack gap={2}>
              {form.creatives.creatives.map((creative, index) => (
                <div
                  key={creative.id}
                  className="rounded-lg bg-base-200/50 p-3"
                >
                  <Typography className="font-medium">
                    {creative.headline || `Creative ${index + 1}`}
                  </Typography>
                  <Typography tone="muted" className="text-sm">
                    {creative.description || "No description"}
                  </Typography>
                </div>
              ))}
            </Stack>
          </Card>
        </Stack>
      </div>

      {launchError ? (
        <Alert title="Launch submission issue" tone="danger">
          {launchError}
        </Alert>
      ) : null}
      {launchResult ? (
        <div data-testid="launch-result">
          <Alert title="Campaign demo saved" tone="success">
            {launchResult.message} Reference: {launchResult.launchId}.
            Platforms: {launchResult.platformsInvoked.join(", ") || "none"}.
            Uniform payload:{" "}
            {launchResult.uniformPayload ? "confirmed" : "not confirmed"}.
          </Alert>
        </div>
      ) : null}
    </Stack>
  );
}
