import { prisma } from "../prisma/client";
import { securityResponse } from "../security/errors";
import { customerAuth } from "../security/runtime";
import { createFunnelApi } from "./funnelApi";
import { FunnelService } from "./funnelService";

export function funnelService() {
  return new FunnelService(prisma, customerAuth());
}

export async function handleFunnelApi(request: Request) {
  try { return await createFunnelApi(customerAuth(), funnelService())(request); }
  catch (error) { return securityResponse(error); }
}
