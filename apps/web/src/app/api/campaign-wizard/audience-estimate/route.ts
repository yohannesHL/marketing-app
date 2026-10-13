import { NextResponse } from "next/server";

import {
  calculateAudienceEstimate,
  parseGoal,
  parseTargeting,
} from "../../../../server/campaign-wizard/services/campaignWizardService";

export async function POST(request: Request) {
  const body = (await request.json()) as { goal?: unknown; targeting?: unknown };
  const goal = parseGoal(body.goal);
  const targeting = parseTargeting(body.targeting);

  if (goal === null || targeting === null) {
    return NextResponse.json({ message: "Audience targeting requires a valid goal and targeting payload." }, { status: 400 });
  }

  return NextResponse.json(calculateAudienceEstimate({ goal, targeting }));
}
