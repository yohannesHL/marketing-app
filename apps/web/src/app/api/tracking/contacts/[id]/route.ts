import { handleTrackingApi } from "../../../../../server/funnels/trackingRuntime";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function DELETE(request: Request) { return handleTrackingApi(request); }
