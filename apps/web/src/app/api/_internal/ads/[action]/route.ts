import { handleAdsRoute } from "../../../../server/routes/ads";

export async function GET(
  request: Request,
  context: { params: Promise<{ action: string }> },
) {
  return handleAdsRoute((await context.params).action, request);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ action: string }> },
) {
  return handleAdsRoute((await context.params).action, request);
}
