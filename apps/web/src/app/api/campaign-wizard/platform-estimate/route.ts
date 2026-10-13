import { NextResponse } from "next/server";

import {
  calculatePlatformEstimates,
  parseGoal,
  parsePositiveNumber,
  parseSelectedPlatforms,
} from "../../../../server/campaign-wizard/services/campaignWizardService";

export async function POST(request: Request) {
  const body = (await request.json()) as {
    goal?: unknown;
    totalBudget?: unknown;
    selectedPlatforms?: unknown;
  };
  const goal = parseGoal(body.goal);
  const totalBudget = parsePositiveNumber(body.totalBudget);
  const selectedPlatforms = parseSelectedPlatforms(body.selectedPlatforms);

  if (goal === null || totalBudget === null || selectedPlatforms === null) {
    return NextResponse.json({ message: "Platform estimation requires a valid goal, total budget, and selected platforms." }, { status: 400 });
  }

  return NextResponse.json(calculatePlatformEstimates({ goal, totalBudget, selectedPlatforms }));
}
