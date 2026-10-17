import { handleFunnelApi } from "../../../../server/funnels/funnelRuntime";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) { return handleFunnelApi(request); }
export async function PATCH(request: Request) { return handleFunnelApi(request); }
