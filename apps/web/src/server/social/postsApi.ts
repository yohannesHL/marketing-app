import { CustomerAuth } from "../auth/customerAuth";
import { customerAuth } from "../security/runtime";
import { fail, privateJson, readBody, securityResponse } from "../security/errors";
import { SocialPostService } from "./postService";
import { type SocialDraftInput, type SocialScheduleInput } from "./types";
import { socialPostService } from "./runtime";

function fields(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail("INVALID_BODY", 400, "Supply only supported post fields.");
}
function input(body: Record<string, unknown>, edit = false): SocialDraftInput {
  fields(body, ["title", "body", "mediaIds", "variants", ...(edit ? ["revisionId"] : [])]);
  if (!Array.isArray(body.variants)) fail("INVALID_BODY", 400, "Supply explicit destination variants.");
  for (const value of body.variants) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_BODY", 400, "Supply valid destination variants.");
    fields(value as Record<string, unknown>, ["destinationId", "format", "title", "body", "mediaIds", "providerOptions"]);
  }
  return { title: body.title as string, body: body.body as string, mediaIds: body.mediaIds as string[], variants: body.variants as SocialDraftInput["variants"] };
}
export function createSocialPostsApi(auth: CustomerAuth, service: SocialPostService) {
  return async (request: Request): Promise<Response> => {
    try {
      const principal = await auth.requireSession(request);
      if (request.method !== "GET") auth.assertOrigin(request);
      const path = new URL(request.url).pathname;
      if (path === "/api/social/posts") {
        if (request.method === "GET") return privateJson(await service.list(principal));
        if (request.method === "POST") return privateJson(await service.create(principal, input(await readBody(request))), 201);
        fail("METHOD_NOT_ALLOWED", 405, "Use GET or POST for social posts.");
      }
      const match = path.match(/^\/api\/social\/posts\/([A-Za-z0-9_-]{1,128})(?:\/(approve|enqueue|cancel|reschedule|retry|deliveries))?$/);
      if (!match) fail("NOT_FOUND", 404, "Social post route not found.");
      const [, id, action] = match;
      if (request.method === "GET" && !action) return privateJson(await service.get(principal, id));
      if (request.method === "GET" && action === "deliveries") return privateJson({ deliveries: (await service.get(principal, id)).deliveries });
      if (request.method === "PATCH" && !action) {
        const body = await readBody(request);
        if (typeof body.revisionId !== "string") fail("INVALID_BODY", 400, "Supply the current revision ID.");
        return privateJson(await service.edit(principal, id, body.revisionId, input(body, true)));
      }
      if (request.method !== "POST" || !action) fail("METHOD_NOT_ALLOWED", 405, "Use the supported social post action.");
      const body = await readBody(request);
      if (action === "approve") {
        fields(body, ["revisionId", "destinationIds"]);
        if (typeof body.revisionId !== "string") fail("INVALID_BODY", 400, "Supply the current revision ID.");
        return privateJson(await service.approve(principal, id, body.revisionId, body.destinationIds as string[]));
      }
      if (action === "enqueue") {
        fields(body, ["revisionId", "destinationIds", "enqueueId", "dueAt", "timeZone"]);
        if (typeof body.revisionId !== "string") fail("INVALID_BODY", 400, "Supply the current revision ID.");
        return privateJson(await service.enqueue(principal, id, body as SocialScheduleInput));
      }
      fields(body, action === "reschedule" ? ["deliveryIds", "dueAt", "timeZone"] : ["deliveryIds"]);
      if (action === "cancel") return privateJson(await service.cancel(principal, id, body.deliveryIds as string[]));
      if (action === "retry") return privateJson(await service.retry(principal, id, body.deliveryIds as string[]));
      if (action === "reschedule") return privateJson(await service.reschedule(principal, id, body.deliveryIds as string[], body.dueAt as string, body.timeZone as string));
      fail("NOT_FOUND", 404, "Social post route not found.");
    } catch (error) { return securityResponse(error); }
  };
}

export async function handleSocialPostsApi(request: Request) {
  try { const auth = customerAuth(); await auth.requireSession(request); return await createSocialPostsApi(auth, socialPostService())(request); }
  catch (error) { return securityResponse(error); }
}
