import type { CustomerAuth } from "../auth/customerAuth";
import { fail, privateJson, securityResponse } from "../security/errors";
import type { FunnelReportingService } from "./funnelReportingService";

export function createFunnelReportingApi(auth: CustomerAuth, service: FunnelReportingService) {
  return async (request: Request): Promise<Response> => {
    try {
      const principal = await auth.requireSession(request);
      if (request.method !== "GET") auth.assertOrigin(request);
      const url = new URL(request.url), match = url.pathname.match(/^\/api\/funnels\/([A-Za-z0-9_-]{1,128})\/reports$/);
      if (request.method !== "GET" || !match) return privateJson({ code: "NOT_FOUND", message: "Report endpoint not found." }, 404);
      for (const key of url.searchParams.keys()) if (!["versionId", "from", "to"].includes(key) || url.searchParams.getAll(key).length !== 1)
        fail("INVALID_REPORT_RANGE", 400, "Use only a published version and an entry interval. Historical snapshots are not supported.");
      return privateJson(await service.report(principal, match[1], { versionId: url.searchParams.get("versionId") ?? undefined,
        from: url.searchParams.get("from") ?? "", to: url.searchParams.get("to") ?? "" }));
    } catch (error) { return securityResponse(error); }
  };
}
