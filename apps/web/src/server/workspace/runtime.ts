import { prisma } from "../prisma/client";
import { customerAuth } from "../security/runtime";
import { securityResponse } from "../security/errors";
import { createWorkspaceApi } from "./api";
import { WorkspaceService } from "./service";
export async function handleWorkspaceApi(request: Request) {
  try { return await createWorkspaceApi(customerAuth(), new WorkspaceService(prisma))(request); }
  catch (error) { return securityResponse(error); }
}
