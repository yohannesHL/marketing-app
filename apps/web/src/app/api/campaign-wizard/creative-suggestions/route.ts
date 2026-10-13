import { NextResponse } from "next/server";

import {
  generateCreativeSuggestions,
  parseBudgetPlan,
  parseGoal,
  parseTargeting,
} from "../../../../server/campaign-wizard/services/campaignWizardService";

export async function POST(request: Request) {
  const body = (await request.json()) as {
    goal?: unknown;
    audience?: unknown;
    budget?: unknown;
  };
  const goal = parseGoal(body.goal);
  const audience = parseTargeting(body.audience);
  const budget = parseBudgetPlan(body.budget);

  if (goal === null || audience === null || budget === null) {
    return NextResponse.json({ message: "Creative generation requires valid goal, audience, and budget inputs." }, { status: 400 });
  }

  return NextResponse.json(generateCreativeSuggestions({ goal, audience, budget }));
}
