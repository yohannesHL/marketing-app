import { handleWorkspaceApi } from "../../../../server/workspace/runtime";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return handleWorkspaceApi(request); }
export async function PATCH(request: Request) { return handleWorkspaceApi(request); }
