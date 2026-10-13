"use client";

import { Card, Grid, Input, Stack, Typography } from "@launchpad/ui";

import type { BudgetRecommendationResponse } from "@launchpad/core";

import { formatCurrency, type BudgetFormState } from "./state";

type BudgetStepProps = {
  budget: BudgetFormState;
  insight: BudgetRecommendationResponse | null;
  error: string | null;
  isLoading: boolean;
  onBudgetChange: (field: keyof BudgetFormState, value: string) => void;
};

export function BudgetStep({
  budget,
  insight,
  error,
  isLoading,
  onBudgetChange,
}: BudgetStepProps) {
  const dailyBudget = budget.dailyBudget
    ? Number.parseInt(budget.dailyBudget, 10)
    : 0;
  const durationDays = budget.durationInDays
    ? Number.parseInt(budget.durationInDays, 10)
    : 0;
  const totalBudget = budget.totalBudget
    ? Number.parseInt(budget.totalBudget, 10)
    : 0;

  return (
    <Stack gap={8}>
      <div>
        <Typography variant="heading-3" className="mb-2">
          Budget & Schedule
        </Typography>
        <Typography tone="muted">
          Set your campaign budget and duration.
        </Typography>
      </div>

      <Grid minItemWidth="14rem">
        <Input
          inputMode="numeric"
          label="Daily Budget"
          leadingAdornment={<span className="text-base-content/60">$</span>}
          onChange={(event) =>
            onBudgetChange("dailyBudget", event.target.value)
          }
          placeholder="50"
          value={budget.dailyBudget}
        />
        <Input
          inputMode="numeric"
          label="Duration (days)"
          onChange={(event) =>
            onBudgetChange("durationInDays", event.target.value)
          }
          placeholder="14"
          value={budget.durationInDays}
        />
        <Input
          inputMode="numeric"
          label="Total Budget"
          leadingAdornment={<span className="text-base-content/60">$</span>}
          onChange={(event) =>
            onBudgetChange("totalBudget", event.target.value)
          }
          placeholder="700"
          value={budget.totalBudget}
        />
      </Grid>

      <Card className="bg-base-200/50" data-testid="budget-insights">
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
              <svg
                className="h-5 w-5 text-primary"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                viewBox="0 0 24 24"
              >
                <path
                  d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <div>
              <Typography className="font-semibold">Budget Summary</Typography>
              <Typography tone="muted" className="text-sm">
                {dailyBudget > 0 && durationDays > 0
                  ? `${formatCurrency(dailyBudget)}/day × ${durationDays} days = ${formatCurrency(dailyBudget * durationDays)}`
                  : "Enter budget details to see summary"}
              </Typography>
            </div>
          </div>

          {insight && (
            <div className="border-t border-base-300 pt-4">
              <Grid minItemWidth="10rem">
                <div>
                  <Typography tone="muted" className="text-xs">
                    Recommended
                  </Typography>
                  <Typography className="font-semibold">
                    {formatCurrency(insight.recommendedBudget)}
                  </Typography>
                </div>
                <div>
                  <Typography tone="muted" className="text-xs">
                    Est. Reach
                  </Typography>
                  <Typography className="font-semibold">
                    {insight.estimatedReach.toLocaleString()}
                  </Typography>
                </div>
              </Grid>
            </div>
          )}
        </div>
      </Card>
    </Stack>
  );
}
