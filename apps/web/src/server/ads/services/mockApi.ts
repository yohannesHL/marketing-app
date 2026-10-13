import type { Prisma } from "../../../generated/prisma/client";
import { prisma } from "../../prisma/client";
import { customerAuth } from "../../security/runtime";
import {
  fail,
  privateJson,
  readBody,
  securityResponse,
} from "../../security/errors";
import { recordDownstreamCall } from "../repositories/adsExecutionRepository";

export async function handleMockAds(request: Request, platform: string) {
  try {
    const auth = customerAuth();
    const principal = await auth.requireSession(request);
    auth.assertOrigin(request);
    if (process.env.ADS_MODE !== "mock" || process.env.CONNECTION_MODE === "live")
      fail("MOCK_DISABLED", 404, "Endpoint not found.");
    const invocationId = request.headers.get("x-ads-invocation-id");
    const invocation = invocationId
      ? await prisma.adPlatformInvocation.findFirst({
          where: {
            id: invocationId,
            platform: platform.toUpperCase() as never,
            success: null,
            execution: { ownerId: principal.userId },
          },
        })
      : null;
    if (!invocation) fail("NOT_FOUND", 404, "Invocation not found.");
    const body = await readBody(request);
    const path = typeof body.path === "string" ? body.path : "/unknown";
    const slug = `${platform}-${invocation.id}`;
    const response =
      platform.toUpperCase() === "GOOGLE"
        ? { results: [{ resourceName: `customers/mock/${slug}` }] }
        : platform.toUpperCase() === "META"
          ? path.includes("adimages")
            ? { images: { hash: `hash-${slug}` } }
            : { id: `meta-${slug}` }
          : {
              data: path.includes("asset")
                ? { asset_id: `asset-${slug}` }
                : {
                    campaign_id: `campaign-${slug}`,
                    adgroup_id: `adgroup-${slug}`,
                    ad_id: `ad-${slug}`,
                    audience_id: `audience-${slug}`,
                  },
            };
    await recordDownstreamCall({
      invocationId: invocation.id,
      downstreamPath: path,
      downstreamRequest: body as Prisma.InputJsonValue,
      downstreamResponse: response,
    });
    return privateJson(response);
  } catch (error) {
    return securityResponse(error);
  }
}
