import { prisma } from "../prisma/client";
import { securityResponse } from "../security/errors";
import { customerAuth } from "../security/runtime";
import { createFunnelReportingApi } from "./funnelReportingApi";
import { FunnelReportingService } from "./funnelReportingService";

export function funnelReportingService() { return new FunnelReportingService(prisma, customerAuth()); }
export async function handleFunnelReportingApi(request: Request) {
  try { return await createFunnelReportingApi(customerAuth(), funnelReportingService())(request); }
  catch (error) { return securityResponse(error); }
}
