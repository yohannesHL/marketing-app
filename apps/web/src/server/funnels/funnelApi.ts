import type { CustomerAuth } from "../auth/customerAuth";
import { privateJson, securityResponse } from "../security/errors";
import type { FunnelService } from "./funnelService";
import { boundedBody, json } from "./trackingValidation";

const ID = "([A-Za-z0-9_-]{1,128})";
const definitionBody = async (request: Request) => json(await boundedBody(request, 131_072));

export function createFunnelApi(auth: CustomerAuth, service: FunnelService) {
  return async (request: Request): Promise<Response> => {
    try {
      const principal = await auth.requireSession(request);
      if (request.method !== "GET") auth.assertOrigin(request);
      const url = new URL(request.url), path = url.pathname;
      if (path === "/api/funnels") {
        if (request.method === "GET") return privateJson(await service.list(principal, url.searchParams.get("environment") ?? ""));
        if (request.method === "POST") return privateJson(await service.create(principal, await definitionBody(request)), 201);
      }
      const funnel = path.match(new RegExp(`^/api/funnels/${ID}$`));
      if (funnel) {
        if (request.method === "GET") return privateJson(await service.get(principal, funnel[1]));
        if (request.method === "PATCH") return privateJson(await service.updateDraft(principal, funnel[1], await definitionBody(request)));
      }
      const action = path.match(new RegExp(`^/api/funnels/${ID}/(publish|status|controls|journeys|move|simulate)$`));
      if (action) {
        const [, id, operation] = action;
        if (operation === "publish" && request.method === "POST")
          return privateJson(await service.publish(principal, id, await definitionBody(request)));
        if (operation === "status" && request.method === "PATCH")
          return privateJson(await service.setStatus(principal, id, await definitionBody(request)));
        if (operation === "controls" && request.method === "PATCH")
          return privateJson(await service.controls(principal, id, await definitionBody(request)));
        if (operation === "journeys" && request.method === "GET")
          return privateJson(await service.journeys(principal, id, url.searchParams.get("cursor") ?? undefined));
        if (operation === "move" && request.method === "POST")
          return privateJson(await service.move(principal, id, await definitionBody(request)));
        if (operation === "simulate" && request.method === "POST")
          return privateJson(await service.simulate(principal, id, await definitionBody(request)));
      }
      const history = path.match(new RegExp(`^/api/funnels/${ID}/journeys/${ID}/history$`));
      if (history && request.method === "GET") return privateJson(await service.history(principal, history[1], history[2]));
      const cancel = path.match(new RegExp(`^/api/funnels/${ID}/journeys/${ID}/cancel$`));
      if (cancel && request.method === "POST") return privateJson(await service.cancelJourney(principal, cancel[1], cancel[2], await definitionBody(request)));
      return privateJson({ code: "NOT_FOUND", message: "Funnel endpoint not found." }, 404);
    } catch (error) { return securityResponse(error); }
  };
}
