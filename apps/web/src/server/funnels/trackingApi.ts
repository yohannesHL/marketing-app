import type { CustomerAuth } from "../auth/customerAuth";
import { fail, privateJson, readBody, securityResponse } from "../security/errors";
import type { TrackingService } from "./trackingService";
import { boundedBody, fields, json } from "./trackingValidation";

const ID = "([A-Za-z0-9_-]{1,128})";
const nativePath = new RegExp(`^/api/tracking/ingest/${ID}/(visitor|form|collect)$`);
const apiPath = new RegExp(`^/api/tracking/ingest/${ID}/events$`);
const hookPath = /^\/api\/tracking\/hooks\/([A-Za-z0-9_-]{43})$/;

/** Browser CORS grants no cookies and is added only after the source's exact origin check. */
function nativeCors(response: Response, origin: string) {
  response.headers.set("Access-Control-Allow-Origin", origin);
  response.headers.set("Vary", "Origin");
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export function createTrackingApi(auth: CustomerAuth, service: TrackingService) {
  return async (request: Request): Promise<Response> => {
    let allowedOrigin: string | undefined;
    try {
      const url = new URL(request.url), path = url.pathname;
      const native = path.match(nativePath);
      if (native) {
        const origin = request.headers.get("origin");
        await service.publicSource(native[1], origin);
        allowedOrigin = origin!;
        if (request.method === "OPTIONS") {
          const method = request.headers.get("access-control-request-method");
          const headers = (request.headers.get("access-control-request-headers") ?? "")
            .split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
          if (method !== "POST" || headers.some(header => header !== "content-type"))
            fail("INVALID_PREFLIGHT", 403, "Use a JSON POST without credentials.");
          return nativeCors(new Response(null, { status: 204, headers: {
            "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type",
          } }), allowedOrigin);
        }
        if (request.method !== "POST") fail("METHOD_NOT_ALLOWED", 405, "Use POST for tracking receipts.");
        const raw = await boundedBody(request, 32_768);
        if (native[2] === "visitor") {
          fields(json(raw), []);
          return nativeCors(privateJson(await service.visitor(native[1], origin), 201), allowedOrigin);
        }
        const receipt = await service.collectNative(native[1], origin, raw, native[2] === "form");
        return nativeCors(privateJson(receipt, 202), allowedOrigin);
      }
      const api = path.match(apiPath), hook = path.match(hookPath);
      if (api || hook) {
        if (request.method !== "POST") fail("METHOD_NOT_ALLOWED", 405, "Use POST for tracking receipts.");
        const raw = await boundedBody(request, hook ? 1_048_576 : 32_768);
        return privateJson(api ? await service.collectApi(api[1], request.headers, raw) :
          await service.collectHook(hook![1], request.headers, raw), 202);
      }

      const principal = await auth.requireSession(request);
      if (request.method !== "GET") auth.assertOrigin(request);
      if (path === "/api/tracking/sources") {
        if (request.method === "GET") return privateJson(await service.listSources(principal));
        if (request.method === "POST") return privateJson(await service.createSource(principal, await readBody(request)), 201);
      }
      const source = path.match(new RegExp(`^/api/tracking/sources/${ID}$`));
      if (source && request.method === "PATCH")
        return privateJson(await service.updateSource(principal, source[1], await readBody(request)));
      const sourceAction = path.match(new RegExp(`^/api/tracking/sources/${ID}/(events|audit|correlations|reconcile)$`));
      if (sourceAction) {
        const [, sourceId, action] = sourceAction;
        if (action === "events" && request.method === "GET")
          return privateJson(await service.events(principal, sourceId, url.searchParams.get("cursor") ?? undefined));
        if (action === "audit" && request.method === "GET") return privateJson(await service.audit(principal, sourceId));
        if (action === "correlations" && request.method === "POST")
          return privateJson(await service.createCorrelation(principal, sourceId, await readBody(request)), 201);
        if (action === "reconcile" && request.method === "POST")
          return privateJson(await service.reconcile(principal, sourceId, await readBody(request)), 202);
      }
      const event = path.match(new RegExp(`^/api/tracking/sources/${ID}/events/${ID}/(match|replay)$`));
      if (event && request.method === "POST") {
        const body = await readBody(request);
        if (event[3] === "match") return privateJson(await service.match(principal, event[1], event[2], body), 202);
        fields(body, []);
        return privateJson(await service.replay(principal, event[1], event[2]), 202);
      }
      if (path === "/api/tracking/subjects" && request.method === "GET")
        return privateJson(await service.subjects(principal, url.searchParams.get("environment") ?? ""));
      const contact = path.match(new RegExp(`^/api/tracking/contacts/${ID}$`));
      if (contact && request.method === "DELETE") return privateJson(await service.deleteContact(principal, contact[1]));
      return privateJson({ code: "NOT_FOUND", message: "Tracking endpoint not found." }, 404);
    } catch (error) {
      const response = securityResponse(error);
      return allowedOrigin ? nativeCors(response, allowedOrigin) : response;
    }
  };
}
