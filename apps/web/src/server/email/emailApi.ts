import type { CustomerAuth } from "../auth/customerAuth";
import { fail, privateJson, securityResponse } from "../security/errors";
import { boundedBody, fields, json } from "../funnels/trackingValidation";
import type { EmailConnectionService } from "./emailConnectionService";
import type { EmailDeliveryService } from "./emailDeliveryService";
import type { MarketingCampaignService } from "./marketingCampaignService";
import { EmailProviderError } from "./emailProvider";

const ID = "([A-Za-z0-9_-]{1,128})";
const body = async (request: Request) => json(await boundedBody(request, 131_072));
async function rawBody(request: Request, limit: number) {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const next = await reader.read(); if (next.done) break;
    size += next.value.byteLength;
    if (size > limit) { await reader.cancel(); fail("EMAIL_PAYLOAD_LIMIT", 413, "The request body is too large."); }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks);
}
function confirmation(valid: boolean, completed = false) {
  const title = completed ? "You’re unsubscribed" : valid ? "Unsubscribe from these emails" : "This unsubscribe link is unavailable";
  const description = completed ? "Your email preference has been saved. Messages already submitted may still arrive." :
    valid ? "Confirm to stop marketing emails in this subscription category." : "Contact the sender to update your email preferences.";
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body><main><h1>${title}</h1><p>${description}</p>${valid && !completed ? '<form method="post"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit">Unsubscribe</button></form>' : ''}</main></body></html>`, {
    status: valid ? 200 : 404, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow" },
  });
}

export function createEmailApi(auth: CustomerAuth, connections: EmailConnectionService,
  campaigns: MarketingCampaignService, delivery: EmailDeliveryService) {
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url), path = url.pathname;
      const unsubscribe = path.match(/^\/unsubscribe\/([A-Za-z0-9_-]{43})$/);
      if (unsubscribe) {
        if (request.method === "GET") return confirmation((await delivery.unsubscribeInfo(unsubscribe[1])).valid);
        if (request.method === "POST") {
          // The opaque token is the authority. Email clients send RFC 8058 POST without a dashboard session or Origin.
          await rawBody(request, 4096); await delivery.unsubscribe(unsubscribe[1]); return confirmation(true, true);
        }
        return privateJson({ code: "METHOD_NOT_ALLOWED", message: "Use GET or POST." }, 405, { Allow: "GET, POST" });
      }
      const hook = path.match(/^\/api\/email\/hooks\/([A-Za-z0-9_-]{43})$/);
      if (hook && request.method === "POST") {
        if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
          fail("INVALID_EMAIL_INPUT", 415, "Use application/json.");
        return privateJson(await delivery.ingestWebhook(hook[1], request.headers, await rawBody(request, 1_048_576)), 202);
      }
      const principal = await auth.requireSession(request);
      if (request.method !== "GET") auth.assertOrigin(request);
      if (path === "/api/email/connections") {
        if (request.method === "GET") return privateJson(await connections.list(principal, url.searchParams.get("environment") ?? ""));
        if (request.method === "POST") return privateJson(await connections.create(principal, await body(request)), 201);
      }
      const connection = path.match(new RegExp(`^/api/email/connections/${ID}$`));
      if (connection) {
        if (request.method === "GET") return privateJson(await connections.get(principal, connection[1]));
        if (request.method === "PATCH") return privateJson(await connections.update(principal, connection[1], await body(request)));
      }
      const connectionAction = path.match(new RegExp(`^/api/email/connections/${ID}/(check|senders)$`));
      if (connectionAction) {
        const [, id, operation] = connectionAction;
        if (operation === "check" && request.method === "POST") return privateJson(await connections.check(principal, id));
        if (operation === "senders" && request.method === "GET") return privateJson((await connections.get(principal, id)).senders);
        if (operation === "senders" && request.method === "POST") return privateJson(await connections.createSender(principal, id, await body(request)), 201);
      }
      const sender = path.match(new RegExp(`^/api/email/senders/${ID}/check$`));
      if (sender && request.method === "POST") return privateJson(await connections.checkSender(principal, sender[1]));
      if (path === "/api/marketing-campaigns") {
        if (request.method === "GET") return privateJson(await campaigns.list(principal, url.searchParams.get("environment") ?? ""));
        if (request.method === "POST") return privateJson(await campaigns.create(principal, await body(request)), 201);
      }
      const campaign = path.match(new RegExp(`^/api/marketing-campaigns/${ID}$`));
      if (campaign) {
        if (request.method === "GET") return privateJson(await campaigns.get(principal, campaign[1]));
        if (request.method === "PATCH") return privateJson(await campaigns.updateDraft(principal, campaign[1], await body(request)));
      }
      const campaignAction = path.match(new RegExp(`^/api/marketing-campaigns/${ID}/(publish|controls|memberships|simulate)$`));
      if (campaignAction) {
        const [, id, operation] = campaignAction;
        if (operation === "publish" && request.method === "POST") return privateJson(await campaigns.publish(principal, id, await body(request)));
        if (operation === "simulate" && request.method === "POST") return privateJson(await campaigns.simulate(principal, id, await body(request)));
        if (operation === "controls" && request.method === "PATCH") return privateJson(await campaigns.controls(principal, id, await body(request)));
        if (operation === "memberships" && request.method === "GET") return privateJson(await campaigns.memberships(principal, id, url.searchParams.get("cursor") ?? undefined));
        if (operation === "memberships" && request.method === "POST") return privateJson(await campaigns.enrol(principal, id, await body(request)), 201);
      }
      const membership = path.match(new RegExp(`^/api/email/memberships/${ID}(?:/(stop|dispatch|start))?$`));
      if (membership) {
        const [, id, operation] = membership;
        if (!operation && request.method === "GET") return privateJson(await campaigns.membership(principal, id));
        if (operation === "stop" && request.method === "POST") return privateJson(await campaigns.stop(principal, id, await body(request)));
        if (operation === "start" && request.method === "POST") return privateJson(await campaigns.start(principal, id, await body(request)));
        if (operation === "dispatch" && request.method === "POST") {
          const input = await body(request); fields(input, []);
          const intent = await delivery.createIntent(principal, { membershipId: id });
          return privateJson(await delivery.dispatch(principal, intent.send.id));
        }
      }
      const send = path.match(new RegExp(`^/api/email/sends/${ID}(?:/(reconcile|retry))?$`));
      if (send) {
        const [, id, operation] = send;
        if (!operation && request.method === "GET") return privateJson(await delivery.get(principal, id));
        if (operation === "reconcile" && request.method === "POST") return privateJson(await delivery.reconcile(principal, id, await body(request)));
        if (operation === "retry" && request.method === "POST") { fields(await body(request), []); return privateJson(await delivery.retry(principal, id)); }
      }
      if (path === "/api/email/policy") {
        if (request.method === "GET") return privateJson(await campaigns.policy(principal, url.searchParams.get("contactId") ?? "", url.searchParams.get("category") ?? ""));
        if (request.method === "POST") return privateJson(await campaigns.updatePolicy(principal, await body(request)));
      }
      return privateJson({ code: "NOT_FOUND", message: "Email endpoint not found." }, 404);
    } catch (error) {
      if (error instanceof EmailProviderError) return privateJson({ code: error.code, message: error.message }, error.status);
      return securityResponse(error);
    }
  };
}
