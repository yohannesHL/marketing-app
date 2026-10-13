import { NextResponse } from "next/server";

import { getGoalStrategy, parseGoal } from "../../../../server/campaign-wizard/services/campaignWizardService";

export async function GET(request: Request) {
  const goal = parseGoal(new URL(request.url).searchParams.get("goal"));

  if (goal === null) {
    return NextResponse.json({ message: "A valid campaign goal is required." }, { status: 400 });
  }

  return NextResponse.json(getGoalStrategy(goal));
}
