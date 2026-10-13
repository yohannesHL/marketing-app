import { NextResponse } from "next/server";

import { calculateBudgetRecommendation, parseBudgetPlan } from "../../../../server/campaign-wizard/services/campaignWizardService";

export async function POST(request: Request) {
  const budgetPlan = parseBudgetPlan(await request.json());

  if (budgetPlan === null) {
    return NextResponse.json({ message: "Budget planning requires valid goal, daily budget, duration, and total budget values." }, { status: 400 });
  }

  return NextResponse.json(calculateBudgetRecommendation(budgetPlan));
}
