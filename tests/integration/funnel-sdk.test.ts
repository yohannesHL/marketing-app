import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import type { CustomerAuth } from "../../apps/web/src/server/auth/customerAuth";
import { createTrackingApi } from "../../apps/web/src/server/funnels/trackingApi";
import type { TrackingService } from "../../apps/web/src/server/funnels/trackingService";
import { fail } from "../../apps/web/src/server/security/errors";

type Receipt = { accepted?: boolean; reason?: string };
type Sdk = {
  track(type: string, properties?: Record<string, unknown>): Promise<Receipt>;
  submit(input: Record<string, unknown>): Promise<Receipt>;
  setConsent(value: boolean): void;
};
type SdkOptions = { sourceId: string; endpoint: string; consent: boolean; propertyKeys?: string[] };
type Call = { url: string; init: RequestInit; body: Record<string, unknown> };
const sdkCode = readFileSync(join(process.cwd(), "apps/web/public/launchpad-tracking.js"), "utf8");
const visitorToken = "a".repeat(43);

function browser(transport?: (call: Call) => Promise<Response>) {
  const storage = new Map<string, string>(), calls: Call[] = [];
  let storageAccesses = 0;
  const window = {
    crypto: webcrypto, location: { origin: "https://site.example" },
    sessionStorage: {
      getItem(key: string) { storageAccesses++; return storage.get(key) ?? null; },
      setItem(key: string, value: string) { storageAccesses++; storage.set(key, value); },
      removeItem(key: string) { storageAccesses++; storage.delete(key); },
    },
    async fetch(url: string, init: RequestInit) {
      const call = { url, init, body: JSON.parse(init.body as string) }; calls.push(call);
      if (transport) return transport(call);
      return url.endsWith("/visitor") ? Response.json({ visitorToken, expiresInSeconds: 86400 }) :
        Response.json({ accepted: true, receipts: [{ id: "receipt_1", duplicate: false, conflict: false }] }, { status: 202 });
    },
    LaunchPadTracking: undefined as { create(options: SdkOptions): Sdk } | undefined,
  };
  runInNewContext(sdkCode, { window, URL, TextEncoder, AbortController, Uint8Array });
  return { window, storage, calls, accesses: () => storageAccesses,
    create: (consent = false) => window.LaunchPadTracking!.create({ sourceId: "source_1", endpoint: "https://app.example", consent }) };
}

test("website script and unconsented calls are inert; explicit tracking limits data and shares a consented visit", async () => {
  const b = browser();
  assert.equal(b.accesses(), 0); assert.equal(b.calls.length, 0);
  const sdk = b.create();
  assert.equal((await sdk.track("page.viewed")).reason, "CONSENT_REQUIRED");
  assert.equal((await sdk.submit({ email: "maya@example.test" })).reason, "CONSENT_REQUIRED");
  assert.equal(b.accesses(), 0); assert.equal(b.calls.length, 0);
  sdk.setConsent(true);
  await Promise.all([
    sdk.track("page.viewed", { path: "/pricing?email=private#secret", referrer: "https://search.example/?q=private" }),
    sdk.submit({ eventId: "business_id_1", email: "maya@example.test", name: "Maya", properties: { campaign: "autumn" } }),
  ]);
  assert.equal(b.calls.filter(call => call.url.endsWith("/visitor")).length, 1);
  const observation = b.calls.find(call => call.url.endsWith("/collect"))!;
  const properties = observation.body.properties as Record<string, unknown>;
  assert.equal(properties.path, "/pricing"); assert.equal(properties.referrer, "https://search.example/");
  assert.equal(observation.init.credentials, "omit"); assert.equal(observation.init.referrerPolicy, "no-referrer");
  assert.equal(observation.body.visitorToken, visitorToken);
  assert.match(String(observation.body.eventId), /^[a-f0-9-]{36}$/);
  assert.equal(b.storage.size, 1);
  const sent = b.calls.length;
  await assert.rejects(sdk.track("order.paid", { amount: "12" }));
  await assert.rejects(sdk.submit({ email: "maya@example.test", ownerId: "another" }));
  await assert.rejects(sdk.track("page.viewed", { unconfigured: "private" }));
  await assert.rejects(sdk.track("page.viewed", { campaign: "x".repeat(1001) }));
  assert.equal(b.calls.length, sent);
  sdk.setConsent(false);
  assert.equal(b.storage.size, 0);
  assert.equal((await sdk.track("page.viewed")).reason, "CONSENT_REQUIRED");
  assert.equal(b.calls.length, sent);
  assert.throws(() => b.window.LaunchPadTracking!.create({ sourceId: "s", endpoint: "https://app.example/?token=private", consent: true }));
});

test("withdrawing consent while visitor creation is in flight aborts and never stores or sends that visit", async () => {
  let complete!: (response: Response) => void;
  const b = browser(() => new Promise(resolve => { complete = resolve; }));
  const sdk = b.create(true);
  const attempt = sdk.track("page.viewed", { path: "/pricing" });
  const rejected = assert.rejects(attempt, /consent was withdrawn/i);
  assert.equal(b.calls.length, 1);
  sdk.setConsent(false);
  assert.equal(b.calls[0].init.signal?.aborted, true);
  // Simulate a transport that delivers a response despite cancellation.
  complete(Response.json({ visitorToken, expiresInSeconds: 86400 }));
  await rejected;
  assert.equal(b.storage.size, 0); assert.equal(b.calls.length, 1);
  assert.equal((await sdk.track("page.viewed")).reason, "CONSENT_REQUIRED");
});

test("explicit withdrawal clears an earlier session visit even when this SDK instance started without consent", () => {
  const b = browser();
  const key = "launchpad-visit-v1:https://app.example:source_1";
  b.storage.set(key, JSON.stringify({ token: visitorToken, expiresAt: Date.now() + 10000 }));
  const sdk = b.create(false);
  assert.equal(b.accesses(), 0); assert.equal(b.storage.size, 1);
  sdk.setConsent(false);
  assert.equal(b.storage.size, 0); assert.equal(b.calls.length, 0);
});

test("native receipt errors preserve exact-origin CORS and remain bounded and free of submitted data", async () => {
  const site = "https://site.example";
  let receipts = 0;
  const service = {
    async publicSource(_id: string, origin: string | null) {
      if (origin !== site) fail("INVALID_ORIGIN", 403, "The site origin is not allowed for this source.");
      return {};
    },
    async visitor() { throw new Error("Unexpected visitor call"); },
    async collectNative() { receipts++; throw new Error("Provider exception contains secret-token and maya@example.test"); },
  } as unknown as TrackingService;
  const auth = { async requireSession() { throw new Error("Native receipt should not use a customer session"); } } as unknown as CustomerAuth;
  const handler = createTrackingApi(auth, service);
  const request = (body: string, origin = site, contentType = "application/json") => new Request("https://app.example/api/tracking/ingest/source_1/form", {
    method: "POST", headers: { Origin: origin, "Content-Type": contentType }, body,
  });
  const oversized = await handler(request(JSON.stringify({ email: "maya@example.test", properties: { text: "x".repeat(32768) } })));
  assert.equal(oversized.status, 413); assert.equal(receipts, 0);
  assert.equal(oversized.headers.get("Access-Control-Allow-Origin"), site);
  assert.equal(oversized.headers.get("Access-Control-Allow-Credentials"), null);
  assert.equal(oversized.headers.get("Cache-Control"), "no-store");
  assert.equal(oversized.headers.get("Vary"), "Origin");
  const format = await handler(request("email=maya@example.test", site, "text/plain"));
  assert.equal(format.status, 415); assert.equal(receipts, 0);
  assert.equal(format.headers.get("Access-Control-Allow-Origin"), site);
  const denied = await handler(request("{}", "https://untrusted.example"));
  assert.equal(denied.status, 403); assert.equal(denied.headers.get("Access-Control-Allow-Origin"), null);
  const failure = await handler(request(JSON.stringify({ email: "maya@example.test" })));
  assert.equal(failure.status, 500); assert.equal(receipts, 1);
  assert.equal(failure.headers.get("Access-Control-Allow-Origin"), site);
  assert.deepEqual(await failure.json(), { code: "INTERNAL_ERROR", message: "The request could not be completed." });
  const preflight = await handler(new Request("https://app.example/api/tracking/ingest/source_1/form", {
    method: "OPTIONS", headers: { Origin: site, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
  }));
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), site);
  assert.equal(preflight.headers.get("Access-Control-Allow-Credentials"), null);
});
