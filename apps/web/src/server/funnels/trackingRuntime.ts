import { prisma } from "../prisma/client";
import { CredentialVault } from "../security/credentialVault";
import { securityResponse } from "../security/errors";
import { customerAuth } from "../security/runtime";
import { createTrackingApi } from "./trackingApi";
import { TrackingService } from "./trackingService";

export function trackingService() {
  return new TrackingService(prisma, customerAuth(), CredentialVault.fromEnvironment(),
    () => new Date(), process.env.FUNNEL_LIVE_INGRESS_ENABLED === "true");
}

export async function handleTrackingApi(request: Request) {
  try { return await createTrackingApi(customerAuth(), trackingService())(request); }
  catch (error) { return securityResponse(error); }
}
