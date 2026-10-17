import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import {
  EMAIL_REQUIRED_EVENTS, EmailProviderError, type EmailProviderContext, type FrozenEmailRequest,
  type OutgoingEmail, type ResendProviderConfig,
} from "../../apps/web/src/server/email/emailProvider";
import { createResendProvider } from "../../apps/web/src/server/email/resendProvider";

const NOW = new Date("2026-10-17T12:00:00.000Z");
const EMAIL_ID = "f5ecf67c-e2f4-45d0-b9cc-7768c7cc7f85";
const DOMAIN_ID = "534ab23d-a8e6-4617-8bc8-30295982d81e";
const HOOK_ID = "c92b06d3-f7f0-42a6-9451-894d93bb18fb";
const SECRET = `whsec_${Buffer.alloc(32, 17).toString("base64")}`;
const ENDPOINT = "https://app.example/api/email/hooks/opaque-test-token";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const message: OutgoingEmail = { from: { address: "hello@example.test", name: 'LaunchPad "Team"' },
  to: "maya+enquiry@example.test", replyTo: "reply@example.test", subject: "Your enquiry",
  html: '<p>Hello</p><a href="https://app.example/unsubscribe/opaque">Unsubscribe</a>',
  text: "Hello. Unsubscribe: https://app.example/unsubscribe/opaque",
  unsubscribeUrl: "https://app.example/unsubscribe/opaque", sendRef: "send_opaque_123" };
const context = (overrides: Partial<EmailProviderContext> = {}): EmailProviderContext => ({ environment: "TEST",
  apiKey: "fixture_key", webhookSecret: SECRET, beforeRequest: async () => {}, ...overrides });
type Call = { url: string; init: RequestInit };
function harness(handler: (call: Call) => Promise<Response> | Response = () => Response.json({ id: EMAIL_ID }),
  options: { live?: boolean; enabled?: boolean; now?: () => Date; timeoutMs?: number; maxResponseBytes?: number } = {}) {
  const calls: Call[] = [];
  const transport = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init! }; calls.push(call); return handler(call);
  }) as typeof fetch;
  const provider = createResendProvider({ now: options.now ?? (() => NOW), timeoutMs: options.timeoutMs,
    maxResponseBytes: options.maxResponseBytes, ...(options.live ? { environment: "LIVE", liveEnabled: options.enabled ?? true, fetch: transport } :
      { environment: "TEST", fixture: { origin: "http://127.0.0.1:3998", fetch: transport } }) });
  const request = (): FrozenEmailRequest => ({ ...provider.buildRequest(message), idempotencyKey: "email:send_opaque_123",
    firstSubmittedAt: NOW, idempotencyExpiresAt: new Date(NOW.getTime() + 86_400_000) });
  return { provider, calls, request };
}
function signing(payload: unknown, options: { time?: string; id?: string; secret?: string; raw?: string } = {}) {
  const raw = options.raw ?? JSON.stringify(payload), time = options.time ?? String(NOW.getTime() / 1000), id = options.id ?? "msg_test123";
  const signature = createHmac("sha256", Buffer.from((options.secret ?? SECRET).slice(6), "base64"))
    .update(`${id}.${time}.${raw}`).digest("base64");
  return { rawBody: Buffer.from(raw), headers: new Headers({ "svix-id": id, "svix-timestamp": time, "svix-signature": `v1,${signature}` }),
    webhookSecret: SECRET, now: NOW };
}
function event(type = "email.delivered") {
  return { type, created_at: NOW.toISOString(), data: { email_id: EMAIL_ID, message_id: "<rfc-id@example.test>",
    from: '"LaunchPad Team" <hello@example.test>', to: [message.to], subject: message.subject,
    tags: { launchpad_send: message.sendRef }, click: { ipAddress: "private", link: "https://private.example/secret" } } };
}
function domain(overrides: Record<string, unknown> = {}) {
  return { id: DOMAIN_ID, name: "example.test", status: "verified", capabilities: { sending: "enabled", receiving: "disabled" },
    open_tracking: false, click_tracking: true, ...overrides };
}
function hook(overrides: Record<string, unknown> = {}) {
  return { id: HOOK_ID, status: "enabled", endpoint: ENDPOINT, signing_secret: SECRET, events: [...EMAIL_REQUIRED_EVENTS], ...overrides };
}
const setup = { address: "hello@example.test", domainId: DOMAIN_ID, providerWebhookId: HOOK_ID, expectedWebhookUrlDigest: sha(ENDPOINT) };

test("builder freezes deterministic one-recipient body, opaque tag and unsubscribe headers without duplicating footer", () => {
  const { provider } = harness();
  const built = provider.buildRequest(message);
  assert.deepEqual(built, provider.buildRequest({ ...message }));
  assert.equal(built.requestDigest, sha(built.body));
  const body = JSON.parse(built.body);
  assert.deepEqual(body.to, [message.to]); assert.equal(body.html, message.html); assert.equal(body.text, message.text);
  assert.equal(body.from, '"LaunchPad \\"Team\\"" <hello@example.test>'.replace(/\\\\/g, "\\"));
  assert.deepEqual(body.tags, [{ name: "launchpad_send", value: message.sendRef }]);
  assert.deepEqual(body.headers, { "List-Unsubscribe": `<${message.unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
  for (const patch of [{ subject: "Hello\r\nBcc: stolen@example.test" }, { to: "one@example.test,two@example.test" },
    { unsubscribeUrl: "javascript:alert(1)" }, { unsubscribeUrl: "https://secret@app.example/path" },
    { sendRef: "private@address.example" }, { html: "", text: undefined }, { from: { address: "x@example.test", name: "bad\nname" } }])
    assert.throws(() => provider.buildRequest({ ...message, ...patch }), EmailProviderError);
  assert.throws(() => provider.buildRequest({ ...message, html: "x".repeat(130 * 1024) }), EmailProviderError);
});

test("send uses exact frozen bytes and key, current fence and fixed host, without hidden retries", async () => {
  const h = harness(undefined, { live: true }); const operations: string[] = [];
  const request = h.request();
  const outcome = await h.provider.send(context({ environment: "LIVE", beforeRequest: async op => { operations.push(op); assert.equal(h.calls.length, 0); } }), request);
  assert.deepEqual(outcome, { kind: "ACCEPTED", providerMessageId: EMAIL_ID });
  assert.deepEqual(operations, ["SEND"]); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, "https://api.resend.com/emails");
  assert.equal(h.calls[0].init.body, request.body); assert.equal(h.calls[0].init.redirect, "error");
  assert.equal(h.calls[0].init.credentials, "omit");
  assert.equal(new Headers(h.calls[0].init.headers).get("Idempotency-Key"), request.idempotencyKey);
});

test("invalid frozen body, expired window and failed fence never invoke transport", async () => {
  let clock = NOW; const h = harness(undefined, { now: () => clock }); const original = h.request();
  const mutated = (change: (body: Record<string, unknown>) => void) => {
    const body = JSON.parse(original.body); change(body); const text = JSON.stringify(body);
    return { ...original, body: text, requestDigest: sha(text) };
  };
  const invalids = [
    { ...original, requestDigest: "a".repeat(64) }, mutated(body => { body.cc = ["other@example.test"]; }),
    mutated(body => { body.scheduled_at = "tomorrow"; }), mutated(body => { body.to = [message.to, "other@example.test"]; }),
    mutated(body => { body.headers = { ...(body.headers as object), Bcc: "other@example.test" }; }),
    mutated(body => { body.tags = [{ name: "launchpad_send", value: message.sendRef, unexpected: true }]; }),
    { ...original, idempotencyExpiresAt: new Date(NOW.getTime() + 86_400_001) },
    { ...original, body: `{ "from":"bad",${original.body.slice(1)}`, requestDigest: sha(`{ "from":"bad",${original.body.slice(1)}`) },
  ];
  for (const request of invalids) assert.equal((await h.provider.send(context(), request)).kind, "NOT_SUBMITTED");
  assert.deepEqual(await h.provider.send(context({ beforeRequest: async () => { throw new Error("private account token"); } }), original),
    { kind: "NOT_SUBMITTED", code: "PRECONDITION_FAILED" });
  assert.deepEqual(await h.provider.send(context({ beforeRequest: async () => { clock = original.idempotencyExpiresAt; } }), original),
    { kind: "NOT_SUBMITTED", code: "IDEMPOTENCY_EXPIRED" });
  assert.equal(h.calls.length, 0);
  assert.deepEqual(await h.provider.send(context(), original), { kind: "NOT_SUBMITTED", code: "IDEMPOTENCY_EXPIRED" });
});

test("TEST requires an explicit loopback fixture, never falls back; LIVE disabled and context mismatch stay inert", async () => {
  for (const origin of ["https://api.resend.com", "http://evil.example", "http://127.0.0.1:3998/path", "http://user:secret@localhost", "http://localhost/?query=1"])
    assert.throws(() => createResendProvider({ environment: "TEST", fixture: { origin, fetch } }), EmailProviderError);
  assert.throws(() => createResendProvider({ environment: "TEST" } as ResendProviderConfig), EmailProviderError);
  const testAdapter = harness();
  assert.deepEqual(await testAdapter.provider.send(context({ environment: "LIVE" }), testAdapter.request()), { kind: "NOT_SUBMITTED", code: "MODE_DISABLED" });
  assert.equal(testAdapter.calls.length, 0);
  const disabled = harness(undefined, { live: true, enabled: false });
  assert.deepEqual(await disabled.provider.send(context({ environment: "LIVE" }), disabled.request()), { kind: "NOT_SUBMITTED", code: "MODE_DISABLED" });
  const check = await disabled.provider.checkSender(context({ environment: "LIVE" }), setup);
  assert.equal(check.ready, false); assert.equal(disabled.calls.length, 0);
  await testAdapter.provider.send(context(), testAdapter.request());
  assert.match(testAdapter.calls[0].url, /^http:\/\/127\.0\.0\.1:3998\/emails$/);
});

test("provider rejection is distinct from ambiguous acceptance, including both idempotency conflicts", async () => {
  const cases = [
    [401, "validation_error", "REJECTED", "AUTHENTICATION_FAILED"],
    [403, "invalid_permission", "REJECTED", "PERMISSION_DENIED"],
    [403, "validation_error", "REJECTED", "SENDER_UNAVAILABLE"],
    [422, "missing_required_field", "REJECTED", "VALIDATION_REJECTED"],
    [429, "rate_limit_exceeded", "REJECTED", "RATE_LIMITED"],
    [409, "concurrent_idempotent_requests", "UNKNOWN", "REQUEST_IN_PROGRESS"],
    [409, "invalid_idempotent_request", "UNKNOWN", "IDEMPOTENCY_CONFLICT"],
    [500, "application_error", "UNKNOWN", "PROVIDER_UNCERTAIN"],
    [408, "request_timeout", "UNKNOWN", "PROVIDER_UNCERTAIN"],
    [400, "new_undocumented_name", "UNKNOWN", "PROVIDER_UNCERTAIN"],
  ] as const;
  for (const [status, name, kind, code] of cases) {
    const h = harness(() => Response.json({ name, message: "SECRET: maya@example.test" }, { status, headers: { "Retry-After": "7" } }));
    const result = await h.provider.send(context(), h.request());
    assert.equal(result.kind, kind); assert.equal("code" in result && result.code, code);
    assert.equal(h.calls.length, 1); assert.doesNotMatch(JSON.stringify(result), /SECRET|maya/);
    if (status === 429) assert.deepEqual(result, { kind: "REJECTED", code: "RATE_LIMITED", retryable: true, retryAfterMs: 7000 });
  }
  for (const response of [Response.json({ id: "not-a-uuid" }), new Response("<html>bad</html>", { status: 200 }),
    new Response(null, { status: 302, headers: { location: "https://evil.example" } })]) {
    const h = harness(() => response);
    assert.equal((await h.provider.send(context(), h.request())).kind, "UNKNOWN");
  }
});

test("transport timeout and oversized or stalled responses remain unknown and bounded", async () => {
  const failed = harness(() => { throw new Error("secret token and recipient"); });
  assert.deepEqual(await failed.provider.send(context(), failed.request()), { kind: "UNKNOWN", code: "NETWORK_UNCERTAIN" });
  const hanging = harness(() => new Promise(() => {}), { timeoutMs: 10 });
  assert.deepEqual(await hanging.provider.send(context(), hanging.request()), { kind: "UNKNOWN", code: "NETWORK_UNCERTAIN" });
  assert.equal(hanging.calls[0].init.signal?.aborted, true);
  let cancelled = false;
  const streamed = harness(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(101)); },
    cancel() { cancelled = true; } })), { maxResponseBytes: 100 });
  assert.deepEqual(await streamed.provider.send(context(), streamed.request()), { kind: "UNKNOWN", code: "INVALID_PROVIDER_RESPONSE" });
  assert.equal(cancelled, true);
  let declaredCancelled = false;
  const declared = harness(() => new Response(new ReadableStream({ cancel() { declaredCancelled = true; } }),
    { headers: { "Content-Length": "1001" } }), { maxResponseBytes: 100 });
  assert.equal((await declared.provider.send(context(), declared.request())).kind, "UNKNOWN");
  assert.equal(declaredCancelled, true);
  const stalled = harness(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from("{")); } })), { timeoutMs: 10 });
  assert.equal((await stalled.provider.send(context(), stalled.request())).kind, "UNKNOWN");
});

test("sender readiness requires verified exact domain and sending enabled, not just an enabled capability", async () => {
  for (const [payload, reason] of [
    [domain({ status: "not_started" }), "DOMAIN_NOT_VERIFIED"], [domain({ status: "partially_verified" }), "DOMAIN_NOT_VERIFIED"],
    [domain({ name: "parent.example.test" }), "DOMAIN_MISMATCH"], [domain({ capabilities: { sending: "disabled" } }), "SENDING_DISABLED"],
  ] as const) {
    const h = harness(() => Response.json(payload));
    const result = await h.provider.checkSender(context(), setup);
    assert.equal(result.ready, false); assert.equal(!result.ready && result.reason, reason);
  }
  const ok = harness(() => Response.json(domain()));
  assert.equal((await ok.provider.checkSender(context(), setup)).ready, true);
  assert.equal(ok.calls[0].url, `http://127.0.0.1:3998/domains/${DOMAIN_ID}`);
  const sendOnly = harness(() => Response.json({ name: "restricted_api_key", message: "secret" }, { status: 401 }));
  const result = await sendOnly.provider.checkSender(context(), setup);
  assert.equal(!result.ready && result.code, "PERMISSION_DENIED");
});

test("combined readiness independently fences domain and webhook reads and does not expose setup secrets", async () => {
  const operations: string[] = [];
  const h = harness(call => Response.json(call.url.includes("/domains/") ? domain() : hook()));
  const result = await h.provider.validateSender(context({ beforeRequest: async op => { operations.push(op); } }), setup);
  assert.equal(result.ready, true); assert.deepEqual(operations, ["CHECK_SENDER", "CHECK_WEBHOOK"]);
  assert.doesNotMatch(JSON.stringify(result), /opaque-test-token|whsec_|fixture_key/);
  for (const [payload, reason] of [
    [hook({ endpoint: "https://elsewhere.example/hook" }), "ENDPOINT_MISMATCH"],
    [hook({ status: "disabled" }), "WEBHOOK_DISABLED"], [hook({ events: ["email.sent"] }), "MISSING_EVENTS"],
    [hook({ signing_secret: `whsec_${Buffer.alloc(32, 19).toString("base64")}` }), "SECRET_MISMATCH"],
  ] as const) {
    const candidate = harness(() => Response.json(payload));
    const checked = await candidate.provider.checkWebhook(context(), { webhookId: HOOK_ID, expectedUrlDigest: sha(ENDPOINT), webhookSecret: SECRET, requiredEvents: EMAIL_REQUIRED_EVENTS });
    assert.equal(!checked.ready && checked.reason, reason);
  }
  const incomplete = harness(() => Response.json(domain()));
  const missing = await incomplete.provider.validateSender(context({ webhookSecret: "" }), setup);
  assert.equal(missing.ready, false); assert.equal(missing.webhook.ready, false);
  assert.equal(incomplete.calls.length, 1);
});

test("retrieve preserves corroborating content and distinct IDs; absence never proves nonacceptance", async () => {
  const body = JSON.parse(harness().request().body);
  const payload = { ...body, id: EMAIL_ID, message_id: "<rfc@example.test>", created_at: "2026-10-17 12:00:00.000+00",
    last_event: "delivered", cc: [], bcc: [] };
  const h = harness(() => Response.json(payload));
  const result = await h.provider.retrieve(context(), EMAIL_ID);
  assert.equal(result.kind, "FOUND");
  if (result.kind === "FOUND") {
    assert.equal(result.email.providerMessageId, EMAIL_ID); assert.equal(result.email.messageId, "<rfc@example.test>");
    assert.equal(result.email.html, message.html); assert.equal(result.email.text, message.text);
    assert.equal(result.email.tags.launchpad_send, message.sendRef); assert.deepEqual(result.email.replyTo, [message.replyTo]);
  }
  assert.deepEqual(await harness(() => new Response(null, { status: 404 })).provider.retrieve(context(), EMAIL_ID), { kind: "NOT_FOUND" });
  assert.equal((await harness(() => Response.json({ ...payload, id: DOMAIN_ID })).provider.retrieve(context(), EMAIL_ID)).kind, "UNAVAILABLE");
  const malformed = harness();
  assert.deepEqual(await malformed.provider.retrieve(context(), "../../keys"), { kind: "UNAVAILABLE", code: "INVALID_REQUEST" });
  assert.equal(malformed.calls.length, 0);
});

test("webhook validates exact raw bytes, handles multiple signatures and strips unrelated personal diagnostics", () => {
  const { provider } = harness(); const signed = signing(event());
  const validSignature = signed.headers.get("svix-signature");
  signed.headers.set("svix-signature", `v2,ignored v1,${Buffer.alloc(32).toString("base64")} ${validSignature}`);
  const result = provider.verifyWebhook(signed);
  assert.equal(result.providerDeliveryId, "msg_test123"); assert.equal(result.providerMessageId, EMAIL_ID);
  assert.equal(result.messageId, "<rfc-id@example.test>"); assert.equal(result.tags.launchpad_send, message.sendRef);
  assert.equal(result.rawPayloadDigest, createHash("sha256").update(signed.rawBody).digest("hex"));
  assert.doesNotMatch(JSON.stringify(result), /private\.example|ipAddress|click|whsec_/);
  assert.throws(() => provider.verifyWebhook({ ...signed, rawBody: Buffer.concat([signed.rawBody, Buffer.from(" ")]) }), EmailProviderError);
  assert.throws(() => provider.verifyWebhook({ ...signed, webhookSecret: "whsec_invalid" }), EmailProviderError);
  for (const seconds of [-301, 301]) assert.throws(() => provider.verifyWebhook(signing(event(), { time: String(NOW.getTime() / 1000 + seconds) })), EmailProviderError);
  const sameBody = signing(event(), { time: String(NOW.getTime() / 1000 + 5) });
  assert.equal(provider.verifyWebhook(sameBody).providerDeliveryId, result.providerDeliveryId);
  assert.equal(provider.verifyWebhook(sameBody).rawPayloadDigest, result.rawPayloadDigest);
});

test("verified suppression/unknown events are distinct from message callbacks and malformed signed data is rejected", () => {
  const { provider } = harness();
  const suppression = provider.verifyWebhook(signing({ type: "suppression.added", created_at: NOW.toISOString(),
    data: { email: message.to, origin: "manual", source_id: null, message: "private explanation" } }));
  assert.deepEqual(suppression.suppression, { email: message.to, origin: "manual", sourceId: null });
  assert.equal(suppression.providerMessageId, undefined);
  const unknown = provider.verifyWebhook(signing({ type: "email.future_capability", created_at: NOW.toISOString(), data: { private: "secret" } }));
  assert.equal(unknown.supported, false); assert.equal(unknown.providerMessageId, undefined); assert.doesNotMatch(JSON.stringify(unknown), /secret/);
  const bounced = event("email.bounced") as ReturnType<typeof event> & { data: Record<string, unknown> };
  bounced.data.bounce = { type: "Permanent", subType: "General", message: "private smtp text" };
  assert.deepEqual(provider.verifyWebhook(signing(bounced)).bounce, { type: "Permanent", subType: "General" });
  for (const payload of [{ ...event(), created_at: "not a date" }, { ...event(), data: { ...event().data, email_id: "bad" } },
    { ...event(), data: { ...event().data, tags: [{ name: "launchpad_send", value: "bad-shape" }] } }])
    assert.throws(() => provider.verifyWebhook(signing(payload)), (error: unknown) => error instanceof EmailProviderError && error.code === "WEBHOOK_INVALID");
  assert.throws(() => provider.verifyWebhook(signing({}, { raw: "x".repeat(1024 * 1024 + 1) })),
    (error: unknown) => error instanceof EmailProviderError && error.code === "PAYLOAD_TOO_LARGE");
});
