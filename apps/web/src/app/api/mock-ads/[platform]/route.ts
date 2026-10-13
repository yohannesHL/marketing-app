import { handleMockAds } from "../../../../server/ads/services/mockApi";
export const dynamic = "force-dynamic";
export async function POST(
  request: Request,
  context: { params: Promise<{ platform: string }> },
) {
  return handleMockAds(request, (await context.params).platform);
}
