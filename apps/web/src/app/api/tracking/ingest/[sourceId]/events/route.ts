import { handleTrackingApi } from "../../../../../../server/funnels/trackingRuntime";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request) { return handleTrackingApi(request); }
