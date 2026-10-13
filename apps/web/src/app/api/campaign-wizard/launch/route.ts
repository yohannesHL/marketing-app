import { NextResponse } from "next/server";
import { customerAuth } from "../../../../server/security/runtime";
import {
  fail,
  readBody,
  securityResponse,
} from "../../../../server/security/errors";

import {
  launchCampaign,
  parseBudgetPlan,
  parseCreativeSuggestions,
  parseGoal,
  parseSelectedPlatforms,
  parseTargeting,
} from "../../../../server/campaign-wizard/services/campaignWizardService";

export async function POST(request: Request) {
  try {
    const auth = customerAuth();
    await auth.requireSession(request);
    auth.assertOrigin(request);
    if (process.env.ADS_MODE !== "mock")
      fail(
        "LIVE_ADS_UNAVAILABLE",
        503,
        "Live advertising will be enabled after provider integration validation.",
      );
    const body = (await readBody(request)) as {
      goal?: unknown;
      audience?: unknown;
      budget?: unknown;
      creatives?: unknown;
      selectedPlatforms?: unknown;
    };
    const goal = parseGoal(body.goal);
    const audience = parseTargeting(body.audience);
    const budget = parseBudgetPlan(body.budget);
    const creatives = parseCreativeSuggestions(body.creatives);
    const selectedPlatforms = parseSelectedPlatforms(body.selectedPlatforms);

    if (
      goal === null ||
      audience === null ||
      budget === null ||
      creatives === null ||
      selectedPlatforms === null
    ) {
      return NextResponse.json(
        {
          message:
            "Launch submission requires valid goal, audience, budget, creative, and platform data.",
        },
        { status: 400 },
      );
    }

    return NextResponse.json(
      launchCampaign({
        goal,
        audience,
        budget,
        creatives,
        selectedPlatforms,
      }),
    );
  } catch (error) {
    return securityResponse(error);
  }
}
