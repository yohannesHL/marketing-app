import { handleFunnelApi } from "../../../../../server/funnels/funnelRuntime";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request) { return handleFunnelApi(request); }
