import { NextResponse } from "next/server";

import type { CreateAssetInput, CreateCampaignInput } from "@launchpad/core";
import { customerAuth } from "../../../server/security/runtime";
import {
  fail,
  privateJson,
  readBody,
  securityResponse,
} from "../../../server/security/errors";
import { redact } from "../../../server/security/redact";

import {
  executeCreateAssets,
  executeCreateCampaign,
  getPersistedExecution,
} from "../../../server/ads/services/adsProxyService";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseCreateCampaignPayload(
  value: unknown,
): CreateCampaignInput | null {
  if (!isRecord(value) || !isRecord(value.budget)) {
    return null;
  }

  const name = typeof value.name === "string" ? value.name : null;
  const objective =
    typeof value.objective === "string" ? value.objective : null;
  const dailyBudget =
    typeof value.budget.dailyBudget === "number"
      ? value.budget.dailyBudget
      : null;
  const currency =
    typeof value.budget.currency === "string" ? value.budget.currency : null;

  if (
    name === null ||
    objective === null ||
    dailyBudget === null ||
    currency === null
  ) {
    return null;
  }

  return value as unknown as CreateCampaignInput;
}

function parseCreateAssetsPayload(value: unknown): CreateAssetInput[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  return value.every(
    (entry) =>
      isRecord(entry) &&
      typeof entry.name === "string" &&
      typeof entry.type === "string",
  )
    ? (value as CreateAssetInput[])
    : null;
}

function parsePlatforms(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    return undefined;
  }

  return value as string[];
}

export async function handleAdsRoute(action: string, request: Request) {
  try {
    const auth = customerAuth();
    const principal = await auth.requireSession(request);
    if (request.method !== "GET") auth.assertOrigin(request);
    if (request.method === "GET" && action === "executions") {
      const url = new URL(request.url);
      const executionId = url.searchParams.get("id");

      if (!executionId) {
        return NextResponse.json(
          { message: "Execution id is required." },
          { status: 400 },
        );
      }

      const execution = await getPersistedExecution(
        executionId,
        principal.userId,
      );

      if (execution === null) {
        return NextResponse.json(
          { message: "Execution log not found." },
          { status: 404 },
        );
      }

      return privateJson(redact(execution));
    }

    if (process.env.ADS_MODE !== "mock" || process.env.CONNECTION_MODE === "live") {
      fail("LIVE_ADS_UNAVAILABLE", 503,
        "Live advertising will be enabled after provider integration validation.");
    }

    if (request.method !== "POST") {
      return NextResponse.json(
        { message: "Method not allowed." },
        { status: 405 },
      );
    }

    const body = (await readBody(request)) as {
      payload?: unknown;
      platforms?: unknown;
      source?: unknown;
    };
    const platforms = parsePlatforms(body.platforms);
    const source = typeof body.source === "string" ? body.source : undefined;

    switch (action) {
      case "createCampaign": {
        const payload = parseCreateCampaignPayload(body.payload);

        if (payload === null) {
          return NextResponse.json(
            { message: "A valid createCampaign payload is required." },
            { status: 400 },
          );
        }

        // Customer identity always comes from the authenticated session.
        payload.userId = principal.userId;
        return privateJson(
          redact(
            await executeCreateCampaign({
              payload,
              platforms,
              source,
              ownerId: principal.userId,
              cookie: request.headers.get("cookie") ?? "",
            }),
          ),
        );
      }
      case "createAssets": {
        const payload = parseCreateAssetsPayload(body.payload);

        if (payload === null) {
          return NextResponse.json(
            { message: "A valid createAssets payload is required." },
            { status: 400 },
          );
        }

        return privateJson(
          redact(
            await executeCreateAssets({
              payload,
              platforms,
              source,
              ownerId: principal.userId,
              cookie: request.headers.get("cookie") ?? "",
            }),
          ),
        );
      }
      default:
        return NextResponse.json(
          { message: `Unsupported ads action: ${action}` },
          { status: 404 },
        );
    }
  } catch (error) {
    return securityResponse(error);
  }
}
