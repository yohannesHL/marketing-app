import { handleEmailApi } from "../../../../../server/email/emailRuntime";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function PATCH(request: Request) { return handleEmailApi(request); }
