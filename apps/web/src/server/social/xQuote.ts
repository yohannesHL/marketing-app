import type { PrismaClient } from "../../generated/prisma/client";
import type { CustomerAuth, CustomerPrincipal } from "../auth/customerAuth";
import { customerAuth } from "../security/runtime";
import { prisma } from "../prisma/client";
import { fail, privateJson, readBody, securityResponse } from "../security/errors";
import { xPriceSchedule } from "../providers/xPricing";
import { validateXText, validateXMedia, xCostEstimate, X_SCOPES, type XPriceSchedule } from "../providers/x";
import { identifiers, ownedDestination, verifyFormat, verifyMedia } from "./validation";

/** A local estimate reads only owned inspected records. It never calls X or allocates API spending. */
export async function quoteXPost(db: PrismaClient, auth: CustomerAuth, principal: CustomerPrincipal,
  body: Record<string, unknown>, mode: "mock" | "live", prices: XPriceSchedule, now = new Date()) {
  await auth.assertSession(principal);
  if (Object.keys(body).some(key => !["destinationId", "body", "format", "mediaIds"].includes(key)) ||
    typeof body.destinationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.destinationId) ||
    typeof body.body !== "string" || body.body.length > 10000 || !["TEXT", "IMAGE", "SHORT_VIDEO"].includes(String(body.format)))
    fail("INVALID_POST", 400, "Choose an owned X destination, text, format and inspected attachments.");
  identifiers(body.mediaIds, 4);
  const ids = body.mediaIds;
  const format = body.format as "TEXT" | "IMAGE" | "SHORT_VIDEO";
  return db.$transaction(async tx => {
    const destination = await ownedDestination(tx, principal.userId, body.destinationId as string, mode, now, [...X_SCOPES], true);
    if (destination.authorization.provider !== "X" || destination.kind !== "X_PROFILE") fail("INVALID_DESTINATION", 400, "Choose an X publishing destination.");
    const records = await tx.socialMediaAsset.findMany({ where: { id: { in: ids }, ownerId: principal.userId } });
    verifyMedia(records, principal.userId, ids, now);
    const media = ids.map(id => records.find(record => record.id === id)!);
    verifyFormat(format, "X_PROFILE", media);
    if ((format === "TEXT" && media.length) || (format === "IMAGE" && !media.length) || (format === "SHORT_VIDEO" && media.length !== 1))
      fail("UNSUPPORTED_CONTENT", 400, "Choose text, up to four images or one inspected video.");
    for (const asset of media) validateXMedia(asset, format === "IMAGE" ? "IMAGE" : "SHORT_VIDEO");
    const text = validateXText(body.body as string, media.length);
    const initialEstimateMicros = xCostEstimate(body.body as string, format, media, prices);
    const withRenewalEstimateMicros = initialEstimateMicros + prices.USER_READ;
    if (!Number.isSafeInteger(withRenewalEstimateMicros)) fail("INVALID_CONFIG", 503, "Configure supported X price bounds.");
    return { kind: "ESTIMATED_API_ALLOCATION", mode, weightedLength: text.weightedLength, maxWeightedLength: 280,
      initialEstimateMicros, withRenewalEstimateMicros, includesUrl: text.hasUrls, actualBill: null, providerCreditBalance: null };
  });
}
export function createXQuoteApi(db: PrismaClient, auth: CustomerAuth,
  config: { mode: "mock" | "live"; prices: XPriceSchedule; now?: () => Date }) {
  return async (request: Request) => {
    try {
      const principal = await auth.requireSession(request); auth.assertOrigin(request);
      if (request.method !== "POST") fail("METHOD_NOT_ALLOWED", 405, "Use POST for a local X estimate.");
      return privateJson(await quoteXPost(db, auth, principal, await readBody(request), config.mode, config.prices, config.now?.()));
    } catch (error) { return securityResponse(error); }
  };
}
export async function handleXQuote(request: Request) {
  try {
    const auth = customerAuth(), principal = await auth.requireSession(request);
    auth.assertOrigin(request);
    if (request.method !== "POST") fail("METHOD_NOT_ALLOWED", 405, "Use POST for a local X estimate.");
    const mode = process.env.CONNECTION_MODE;
    if (mode !== "mock" && mode !== "live") fail("PROVIDER_DISABLED", 503, "Configure an explicit X connection mode.");
    return privateJson(await quoteXPost(prisma, auth, principal, await readBody(request), mode, xPriceSchedule()));
  } catch (error) { return securityResponse(error); }
}
