import { handleWorkspaceApi } from "../../../../server/workspace/runtime";
export const dynamic = "force-dynamic";
export async function POST(request: Request) { return handleWorkspaceApi(request); }
