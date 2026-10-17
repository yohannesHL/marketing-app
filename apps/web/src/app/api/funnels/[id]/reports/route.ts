import { handleFunnelReportingApi } from "../../../../../server/funnels/funnelReportingRuntime";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) { return handleFunnelReportingApi(request); }
