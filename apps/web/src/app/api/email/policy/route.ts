import { handleEmailApi } from "../../../../server/email/emailRuntime";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) { return handleEmailApi(request); }
export async function POST(request: Request) { return handleEmailApi(request); }
