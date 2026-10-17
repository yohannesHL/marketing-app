import type { CustomerAuth } from "../auth/customerAuth";
import { fail, privateJson, readBody, securityResponse } from "../security/errors";
import { WorkspaceService } from "./service";

export function createWorkspaceApi(auth: CustomerAuth, service: WorkspaceService) {
  return async (request: Request): Promise<Response> => {
    try {
      const principal = await auth.requireSession(request);
      if (request.method !== "GET") auth.assertOrigin(request);
      const path = new URL(request.url).pathname;
      if (path === "/api/workspace/assist" && request.method === "POST") return privateJson(await service.assist(principal, await readBody(request)));
      if (path === "/api/workspace/campaigns") {
        if (request.method === "GET") return privateJson({ campaigns: await service.list(principal) });
        if (request.method === "POST") return privateJson({ campaign: await service.create(principal, await readBody(request)) }, 201);
      }
      const match = path.match(/^\/api\/workspace\/campaigns\/([A-Za-z0-9_-]{1,128})$/);
      if (match) {
        if (request.method === "GET") return privateJson({ campaign: await service.get(principal, match[1]) });
        if (request.method === "PATCH") return privateJson({ campaign: await service.update(principal, match[1], await readBody(request)) });
      }
      if (path === "/api/workspace/brand") {
        if (request.method === "GET") return privateJson({ brand: await service.brand(principal) });
        if (request.method === "PATCH") return privateJson({ brand: await service.updateBrand(principal, await readBody(request)) });
      }
      if (path === "/api/workspace/summary" && request.method === "GET") return privateJson(await service.summary(principal));
      fail("METHOD_NOT_ALLOWED", 405, "Use a supported workspace action.");
    } catch (error) { return securityResponse(error); }
  };
}
