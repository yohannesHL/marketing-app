import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { createClient } from "@libsql/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../../apps/web/src/generated/prisma/client";
import { CustomerAuth, digest } from "../../apps/web/src/server/auth/customerAuth";
import { CredentialVault } from "../../apps/web/src/server/security/credentialVault";
import { CustomerConnections } from "../../apps/web/src/server/connections/customerConnections";
import { ProviderConnectionState } from "../../apps/web/src/server/connections/providerConnectionState";
import { MetaConnectionService, createMetaConnectionApi, type MetaLifecycleReceiver } from "../../apps/web/src/server/connections/metaConnectionApi";
import { MetaAdsClient } from "../../apps/web/src/server/providers/metaAds";
import { MetaLifecycleStore } from "../../apps/web/src/server/connections/metaLifecycleStore";
import { applyConnectionMigrations } from "../support/test-database";
import { startMockoon } from "../support/mockoon";

let directory: string;
let db: PrismaClient;
let auth: CustomerAuth;
let connections: CustomerConnections;
let state: ProviderConnectionState;
let service: MetaConnectionService;
let api: ReturnType<typeof createMetaConnectionApi>;
let client: MetaAdsClient;
let mock: Awaited<ReturnType<typeof startMockoon>>;
let clock = new Date("2026-10-13T12:00:00Z");
const origin = "https://launchpad.test";
const secret = "fixture-app-secret";

before(async () => {
  mock = await startMockoon("tests/mockoon/meta-ads.json");
  directory = await mkdtemp(join(tmpdir(), "launchpad-meta-"));
  const url = `file:${join(directory, "test.db")}`;
  const sqlite = createClient({ url });
  await applyConnectionMigrations(sqlite);
  sqlite.close();
  db = new PrismaClient({ adapter: new PrismaLibSql({ url }) });
  const vault = new CredentialVault({ test: Buffer.alloc(32, 19).toString("base64") }, "test");
  auth = new CustomerAuth(db, { origin }, () => clock);
  connections = new CustomerConnections(db, auth, vault, () => clock);
  state = new ProviderConnectionState(db, auth, vault, () => clock);
  client = new MetaAdsClient({ appId: "123", appSecret: secret, configId: "456",
    redirectUri: `${origin}/api/connections/meta/callback`, testBaseUrl: mock.origin, now: () => clock });
  service = new MetaConnectionService(auth, connections, state, client, "mock", () => clock);
  api = createMetaConnectionApi(auth, service, { appSecret: secret });
});

async function customer(name: string) {
  const email = `${name}@example.test`;
  await auth.provisionCustomer({ name, email, password: "independent Meta customer connection password" });
  const login = await auth.login(email, "independent Meta customer connection password");
  const cookie = login.cookie.split(";")[0];
  const principal = await auth.requireSession(new Request(origin, { headers: { cookie } }));
  const request = (path: string, body: unknown = {}, method = "POST") => new Request(`${origin}${path}`, {
    method, headers: { cookie, Origin: origin, "Content-Type": "application/json" },
    ...(method !== "GET" ? { body: JSON.stringify(body) } : {}),
  });
  return { principal, cookie, request };
}
const nonce = (start: { authorizationUrl: string }) => new URL(start.authorizationUrl).searchParams.get("state")!;
async function connected(name: string) {
  const owner = await customer(name);
  const result = await service.complete(owner.principal, nonce(await service.start(owner.principal)), "success");
  return { owner, result };
}

test("session/Origin protected Meta OAuth completes through real HTTP consent and exposes only metadata", async () => {
  const alice = await customer("meta-oauth");
  assert.equal((await api(new Request(`${origin}/api/connections/meta/start`, { method: "POST" }))).status, 401);
  assert.equal((await api(new Request(`${origin}/api/connections/meta/start`, { method: "POST",
    headers: { cookie: alice.cookie, Origin: "https://other.test" } }))).status, 403);
  assert.equal((await api(alice.request("/api/connections/meta/start", { accessToken: "forged" }))).status, 400);
  const start = await (await api(alice.request("/api/connections/meta/start"))).json();
  const consent = await fetch(start.authorizationUrl, { redirect: "manual" });
  assert.equal(consent.status, 302);
  const callback = consent.headers.get("location")!;
  const response = await api(new Request(callback, { headers: { cookie: alice.cookie } }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const result = await response.json();
  assert.equal(result.connection.provider, "META");
  assert.equal(result.connection.capability, "ADS");
  assert.equal(result.connection.providerUserId, "1001");
  assert.equal(result.connection.connectionMode, "MOCK");
  assert.equal(result.mode, "mock");
  assert.equal(JSON.stringify(result).includes("long_success"), false);
  assert.equal(JSON.stringify(result).includes("Ciphertext"), false);
  const advertiser = result.connection.destinations.find((d: { externalId: string }) => d.externalId === "111");
  const analyst = result.connection.destinations.find((d: { externalId: string }) => d.externalId === "222");
  const inactive = result.connection.destinations.find((d: { externalId: string }) => d.externalId === "333");
  assert.equal(advertiser.metadata.canWrite, "ALLOWED");
  assert.equal(analyst.metadata.canRead, true);
  assert.equal(analyst.metadata.canWrite, "DENIED");
  assert.equal(inactive.available, false);
  assert.equal((await api(new Request(callback, { headers: { cookie: alice.cookie } }))).status, 400);
});

test("callback state is tenant/session/capability bound, consent denial consumes it and failed grants are absent", async () => {
  const alice = await customer("meta-state-alice");
  const bob = await customer("meta-state-bob");
  const start = await service.start(alice.principal);
  await assert.rejects(service.complete(bob.principal, nonce(start), "success"), { code: "INVALID_OAUTH_STATE" });
  const social = await connections.beginOAuth(alice.principal, { ...service.oauth, capability: "SOCIAL" });
  await assert.rejects(service.complete(alice.principal, social.state, "success"), { code: "INVALID_OAUTH_STATE" });
  const denied = await api(alice.request(`/api/connections/meta/callback?state=${nonce(start)}&error=access_denied`, {}, "GET"));
  assert.equal((await denied.json()).code, "CONSENT_DENIED");
  await assert.rejects(service.complete(alice.principal, nonce(start), "success"), { code: "INVALID_OAUTH_STATE" });
  const missing = await service.start(alice.principal);
  await assert.rejects(service.complete(alice.principal, nonce(missing), "missing"), { code: "MISSING_PERMISSION" });
  assert.deepEqual(await connections.list(alice.principal), []);
});

test("owned reconnect preserves verified subject and mode; browser callback uses fixed redirects", async () => {
  const { owner, result } = await connected("meta-reconnect");
  const bob = await customer("meta-reconnect-other");
  await assert.rejects(service.start(bob.principal, result.connection.id), { code: "NOT_FOUND" });
  const reconnect = await service.start(owner.principal, result.connection.id);
  await assert.rejects(service.complete(owner.principal, nonce(reconnect), "wrong-subject"), { code: "SUBJECT_MISMATCH" });
  assert.equal((await connections.get(owner.principal, result.connection.id)).providerUserId, "1001");
  const attempt = await service.start(owner.principal, result.connection.id);
  const response = await api(new Request(`${origin}/api/connections/meta/callback?state=${nonce(attempt)}&code=success`,
    { headers: { cookie: owner.cookie, accept: "text/html" } }));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), `${origin}/connections?provider=meta&result=connected`);
  const failure = await api(new Request(`${origin}/api/connections/meta/callback?state=forged&error_description=secret`,
    { headers: { cookie: owner.cookie, accept: "text/html" } }));
  assert.equal(failure.headers.get("location"), `${origin}/connections?provider=meta&result=failed`);
  const live = new MetaConnectionService(auth, connections, state, client, "live", () => clock);
  await assert.rejects(live.start(owner.principal, result.connection.id), { code: "CONNECTION_MODE_MISMATCH" });
  await assert.rejects(live.refreshAccounts(owner.principal, result.connection.id), { code: "CONNECTION_MODE_MISMATCH" });
});

test("account read and selection check both tenant ownership and current provider write tasks", async () => {
  const { owner, result } = await connected("meta-selection");
  const bob = await customer("meta-selection-other");
  const advertiser = result.connection.destinations.find((d) => d.externalId === "111")!;
  const analyst = result.connection.destinations.find((d) => d.externalId === "222")!;
  const inactive = result.connection.destinations.find((d) => d.externalId === "333")!;
  await assert.rejects(service.readSmoke(bob.principal, result.connection.id, advertiser.id), { code: "NOT_FOUND" });
  await assert.rejects(service.selectAccount(bob.principal, result.connection.id, advertiser.id), { code: "NOT_FOUND" });
  await assert.rejects(service.selectAccount(owner.principal, result.connection.id, "forged-destination"), { code: "NOT_FOUND" });
  await assert.rejects(service.selectAccount(owner.principal, result.connection.id, analyst.id), { code: "ACCOUNT_UNAVAILABLE" });
  await assert.rejects(service.selectAccount(owner.principal, result.connection.id, inactive.id), { code: "NOT_FOUND" });
  assert.equal((await service.readSmoke(owner.principal, result.connection.id, analyst.id)).canWrite, "DENIED");
  await service.selectAccount(owner.principal, result.connection.id, advertiser.id);
  assert.equal((await connections.get(owner.principal, result.connection.id)).destinations.find((d) => d.id === advertiser.id)?.selected, true);
  assert.equal((await service.readSmoke(owner.principal, result.connection.id, advertiser.id)).canWrite, "ALLOWED");
});

test("Meta expiry requires reconnect instead of a fabricated refresh exchange", async () => {
  const { owner, result } = await connected("meta-expiry");
  const snapshot = await state.grant(owner.principal, result.connection.id, "META");
  await connections.updateCredentials(result.connection.id, snapshot.credentialVersion,
    { accessToken: "long_success", scopes: snapshot.scopes, expiresAt: new Date(clock.getTime() - 1) });
  await assert.rejects(service.refreshAccounts(owner.principal, result.connection.id), { code: "RECONNECT_REQUIRED" });
  const disabled = await connections.get(owner.principal, result.connection.id);
  assert.equal(disabled.status, "RECONNECT_REQUIRED");
  assert.ok(disabled.destinations.every((d) => !d.selected));
  const stored = await db.providerAuthorization.findUniqueOrThrow({ where: { id: result.connection.id } });
  assert.equal(stored.accessCiphertext, null);
  assert.equal(stored.refreshCiphertext, null);
});

test("fresh HTTP role/status denials persist metadata, deselect accounts and cancel queued work", async () => {
  for (const [token, expectedAvailable] of [["lost-role", true], ["disabled-account", false]] as const) {
    const { owner, result } = await connected(`meta-current-${token}`);
    const advertiser = result.connection.destinations.find((d) => d.externalId === "111")!;
    await service.selectAccount(owner.principal, result.connection.id, advertiser.id);
    const snapshot = await state.grant(owner.principal, result.connection.id, "META");
    await connections.updateCredentials(result.connection.id, snapshot.credentialVersion,
      { accessToken: token, scopes: snapshot.scopes, expiresAt: snapshot.expiresAt });
    const job = await connections.queueOperation(owner.principal, advertiser.id, "ADS", client.scopes);
    await assert.rejects(service.selectAccount(owner.principal, result.connection.id, advertiser.id), { code: "ACCOUNT_UNAVAILABLE" });
    const current = (await connections.get(owner.principal, result.connection.id)).destinations.find((d) => d.id === advertiser.id)!;
    assert.equal(current.available, expectedAvailable);
    assert.equal(current.selected, false);
    assert.equal((current.metadata as { canWrite: string }).canWrite, "DENIED");
    assert.equal((await db.connectionOperation.findUniqueOrThrow({ where: { id: job.id } })).status, "CANCELLED");
  }
});

test("a duplicate callback loses its claim without cancelling the winning real HTTP exchange", async () => {
  const owner = await customer("meta-duplicate-callback");
  let reached!: () => void;
  let release!: () => void;
  const exchanged = new Promise<void>((resolve) => { reached = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const delayed = new Proxy(client, { get(target, key) {
    if (key === "exchangeCode") return async (...args: Parameters<MetaAdsClient["exchangeCode"]>) => {
      calls++;
      const grant = await target.exchangeCode(...args); reached(); await held; return grant;
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  const slow = new MetaConnectionService(auth, connections, state, delayed, "mock", () => clock);
  const start = await slow.start(owner.principal);
  const winning = slow.complete(owner.principal, nonce(start), "success");
  await exchanged;
  try {
    await assert.rejects(slow.complete(owner.principal, nonce(start), "success"), { code: "INVALID_OAUTH_STATE" });
  } finally { release(); }
  assert.equal((await winning).connection.status, "CONNECTED");
  assert.equal(calls, 1);
});

test("disconnect during remote discovery cannot restore connection; old synchronization cannot use a fresh version", async () => {
  const { owner, result } = await connected("meta-disconnect-race");
  let reached!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { reached = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const delayed = new Proxy(client, { get(target, key) {
    if (key === "discoverAccounts") return async (token: string) => {
      const rows = await target.discoverAccounts(token); reached(); await held; return rows;
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  const slow = new MetaConnectionService(auth, connections, state, delayed, "mock", () => clock);
  const start = await slow.start(owner.principal, result.connection.id);
  const rejected = assert.rejects(slow.complete(owner.principal, nonce(start), "success"), { code: "INVALID_OAUTH_STATE" });
  await started;
  try { await connections.disconnect(owner.principal, result.connection.id); }
  finally { release(); }
  await rejected;
  assert.equal((await connections.get(owner.principal, result.connection.id)).status, "DISCONNECTED");
  await assert.rejects(state.synchronize(owner.principal, result.connection.id, 0, []), { code: "STALE_CREDENTIALS" });
});

test("an older completed callback cannot synchronize against a newer grant version", async () => {
  const owner = await customer("meta-concurrent-reconsent");
  let reached!: () => void;
  let release!: () => void;
  const completed = new Promise<void>((resolve) => { reached = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const delayed = new Proxy(connections, { get(target, key) {
    if (key === "completeAuthorization") return async (...args: Parameters<CustomerConnections["completeAuthorization"]>) => {
      const result = await target.completeAuthorization(...args); reached(); await held; return result;
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  const slow = new MetaConnectionService(auth, delayed, state, client, "mock", () => clock);
  const first = await slow.start(owner.principal);
  const rejected = assert.rejects(slow.complete(owner.principal, nonce(first), "success"), { code: "STALE_CREDENTIALS" });
  await completed;
  try {
    const second = await service.start(owner.principal);
    await service.complete(owner.principal, nonce(second), "success");
  } finally { release(); }
  await rejected;
  assert.equal((await connections.list(owner.principal))[0].credentialVersion, 2);
});

test("a fresh start cannot replace an existing same-subject grant in another connection mode", async () => {
  const { owner, result } = await connected("meta-mode-upsert");
  await db.providerAuthorization.update({ where: { id: result.connection.id }, data: { connectionMode: "LIVE" } });
  const start = await service.start(owner.principal);
  await assert.rejects(service.complete(owner.principal, nonce(start), "success"), { code: "CONNECTION_MODE_MISMATCH" });
  assert.equal((await connections.get(owner.principal, result.connection.id)).connectionMode, "LIVE");
});

function signed(subject: string, signingSecret = secret, issuedAt = 1, marker?: string) {
  const payload = Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: subject, issued_at: issuedAt,
    ...(marker ? { marker } : {}) })).toString("base64url");
  return `${createHmac("sha256", signingSecret).update(payload).digest("base64url")}.${payload}`;
}
function callback(path: string, value: string) {
  return new Request(`${origin}/api/connections/meta/${path}`, { method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ signed_request: value }) });
}

test("lifecycle routes verify signatures before injected receiver delegation; no persistence success is assumed", async () => {
  const received: string[] = [];
  const events: { eventId: string; issuedAt?: number }[] = [];
  const receipt = "OpaqueReceipt12345678";
  // This receiver records delegation only. The following scenarios exercise
  // actual revocation/deletion persistence through the signed routes.
  const receiver: MetaLifecycleReceiver = {
    async deauthorize(subject, event) { received.push(`deauthorize:${subject}`); events.push(event!); },
    async deleteData(subject, event) { received.push(`delete:${subject}`); events.push(event!); return {
      url: `${origin}/api/connections/meta/deletion-status/${receipt}`, confirmation_code: receipt }; },
    async receipt(id) { received.push(`receipt:${id}`); return { status: "PENDING" }; },
  };
  const lifecycleApi = createMetaConnectionApi(auth, service, { appSecret: secret, lifecycle: receiver });
  assert.equal((await lifecycleApi(callback("deauthorize", signed("1001", "attacker")))).status, 400);
  assert.equal((await lifecycleApi(new Request(`${origin}/api/connections/meta/deauthorize`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ signed_request: signed("1001") }),
  }))).status, 400);
  assert.equal((await lifecycleApi(new Request(`${origin}/api/connections/meta/deauthorize`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams([["signed_request", signed("1001")], ["signed_request", signed("1001")]]),
  }))).status, 400);
  assert.equal((await lifecycleApi(new Request(`${origin}/api/connections/meta/deletion-status/invalid`))).status, 404);
  assert.deepEqual(received, []);
  assert.equal((await api(callback("deauthorize", signed("1001")))).status, 503);
  assert.equal((await lifecycleApi(callback("deauthorize", signed("1001")))).status, 200);
  const deletion = await lifecycleApi(callback("data-deletion", signed("1001")));
  assert.deepEqual(await deletion.json(), { url: `${origin}/api/connections/meta/deletion-status/${receipt}`, confirmation_code: receipt });
  const status = await lifecycleApi(new Request(`${origin}/api/connections/meta/deletion-status/${receipt}`));
  assert.deepEqual(await status.json(), { status: "PENDING" });
  const statusPage = await lifecycleApi(new Request(`${origin}/api/connections/meta/deletion-status/${receipt}`,
    { headers: { accept: "text/html" } }));
  assert.equal(statusPage.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(await statusPage.text(), /Request status: PENDING/);
  assert.deepEqual(received, ["deauthorize:1001", "delete:1001", `receipt:${receipt}`, `receipt:${receipt}`]);
  assert.deepEqual(events, [
    { eventId: digest(signed("1001")), issuedAt: 1 },
    { eventId: digest(signed("1001")), issuedAt: 1 },
  ]);
});

test("real persistent signed removal revokes both Meta capabilities, fences pending consent, isolates mode and preserves later reconsent", async () => {
  const { owner, result } = await connected("meta-lifecycle-real");
  const social = { ...service.oauth, capability: "SOCIAL" as const, scopes: ["pages_manage_posts"] };
  const attempt = await connections.beginOAuth(owner.principal, social);
  const socialGrant = await connections.completeAuthorization(owner.principal, attempt.state, social, {
    providerUserId: "1001", externalGrantId: "1001", accessToken: "private-meta-social",
    scopes: social.scopes, connectionMode: "MOCK",
  });
  const google = { ...service.oauth, provider: "GOOGLE" as const,
    scopes: ["google-fixture"], redirectUri: `${origin}/api/connections/google/callback` };
  const googleAttempt = await connections.beginOAuth(owner.principal, google);
  const independent = await connections.completeAuthorization(owner.principal, googleAttempt.state, google, {
    providerUserId: "separate-google-subject", accessToken: "private-google-token",
    scopes: google.scopes, connectionMode: "MOCK",
  });
  const otherMode = await connected("meta-lifecycle-live-fixture");
  await db.providerAuthorization.update({ where: { id: otherMode.result.connection.id }, data: { connectionMode: "LIVE" } });
  const advertiser = result.connection.destinations.find((d) => d.externalId === "111")!;
  await service.selectAccount(owner.principal, result.connection.id, advertiser.id);
  const job = await connections.queueOperation(owner.principal, advertiser.id, "ADS", client.scopes);
  const pending = await service.start(owner.principal, result.connection.id);
  const receiver = new MetaLifecycleStore(db, { origin, mode: "mock" }, () => clock);
  const lifecycleApi = createMetaConnectionApi(auth, service, { appSecret: secret, lifecycle: receiver });
  const event = signed("1001", secret, clock.getTime() / 1000);
  const response = await lifecycleApi(callback("deauthorize", event));
  assert.equal(response.status, 200);
  assert.equal((await connections.get(owner.principal, result.connection.id)).status, "REVOKED");
  assert.equal((await connections.get(owner.principal, socialGrant.id)).status, "REVOKED");
  assert.equal((await connections.get(owner.principal, independent.id)).status, "CONNECTED");
  assert.equal((await connections.get(otherMode.owner.principal, otherMode.result.connection.id)).status, "CONNECTED");
  assert.equal((await db.connectionOperation.findUniqueOrThrow({ where: { id: job.id } })).status, "CANCELLED");
  const stored = await db.providerAuthorization.findUniqueOrThrow({ where: { id: result.connection.id } });
  assert.equal(stored.accessCiphertext, null);
  assert.equal(stored.refreshCiphertext, null);
  await assert.rejects(service.complete(owner.principal, nonce(pending), "success"), { code: "INVALID_OAUTH_STATE" });
  clock = new Date(clock.getTime() + 2000);
  const fresh = await service.start(owner.principal, result.connection.id);
  await service.complete(owner.principal, nonce(fresh), "success");
  const newGrant = await connections.get(owner.principal, result.connection.id);
  assert.equal(newGrant.status, "CONNECTED");
  assert.equal((await lifecycleApi(callback("deauthorize", event))).status, 200);
  assert.equal((await connections.get(owner.principal, result.connection.id)).credentialVersion, newGrant.credentialVersion);
  // A different authenticated event with an older issued_at also cannot touch
  // the newer authorizedAt, even if its event hash has not been seen before.
  assert.equal((await lifecycleApi(callback("deauthorize", signed("1001", secret,
    clock.getTime() / 1000 - 2, "delayed-old-event")))).status, 200);
  assert.equal((await connections.get(owner.principal, result.connection.id)).status, "CONNECTED");
});

test("real signed data deletion erases Meta connections and returns an idempotent public truthful receipt", async () => {
  clock = new Date(clock.getTime() + 2000);
  const { owner, result } = await connected("meta-deletion-real");
  const targetedDestination = result.connection.destinations.find((d) => d.externalId === "111")!;
  const independentGoogleOAuth = { ...service.oauth, provider: "GOOGLE" as const,
    scopes: ["google-fixture"], redirectUri: `${origin}/api/connections/google/callback` };
  const googleAttempt = await connections.beginOAuth(owner.principal, independentGoogleOAuth);
  const googleGrant = await connections.completeAuthorization(owner.principal, googleAttempt.state, independentGoogleOAuth, {
    providerUserId: "google-deletion-independent", accessToken: "private-google-independent",
    scopes: independentGoogleOAuth.scopes, connectionMode: "MOCK",
  });
  const googleDestination = await connections.registerDestination(owner.principal, googleGrant.id,
    { externalId: "google-501", kind: "AD_ACCOUNT" });
  const liveAttempt = await connections.beginOAuth(owner.principal, service.oauth);
  const liveGrant = await connections.completeAuthorization(owner.principal, liveAttempt.state, service.oauth, {
    providerUserId: "2002", externalGrantId: "2002", accessToken: "private-live-independent",
    scopes: client.scopes, connectionMode: "LIVE",
  });
  const liveDestination = await connections.registerDestination(owner.principal, liveGrant.id,
    { externalId: "777", kind: "AD_ACCOUNT" });
  const metaResult = { platform: "META", authorizationId: result.connection.id,
    destinationId: targetedDestination.id, evidence: "targeted-meta-result" };
  const googleResult = { platform: "GOOGLE", authorizationId: googleGrant.id,
    destinationId: googleDestination.id, evidence: "retained-google-result" };
  const liveResult = { platform: "META", authorizationId: liveGrant.id,
    destinationId: liveDestination.id, evidence: "retained-live-meta-result" };
  const mixed = await db.adProxyExecution.create({ data: {
    operation: "verification", ownerId: owner.principal.userId,
    requestPayload: { targets: [metaResult, googleResult, liveResult] },
    responsePayload: { results: [metaResult, googleResult, liveResult] },
    invocations: { create: [
      { platform: "META", authorizationId: result.connection.id, destinationId: targetedDestination.id,
        connectionMode: "MOCK", adapterPayload: { evidence: "targeted-meta-result" } },
      { platform: "GOOGLE", authorizationId: googleGrant.id, destinationId: googleDestination.id,
        connectionMode: "MOCK", adapterPayload: { evidence: "retained-google-result" } },
      { platform: "META", authorizationId: liveGrant.id, destinationId: liveDestination.id,
        connectionMode: "LIVE", adapterPayload: { evidence: "retained-live-meta-result" } },
    ] },
  } });
  const receiver = new MetaLifecycleStore(db, { origin, mode: "mock" }, () => clock);
  const lifecycleApi = createMetaConnectionApi(auth, service, { appSecret: secret, lifecycle: receiver });
  const event = signed("1001", secret, clock.getTime() / 1000);
  const deleted = await lifecycleApi(callback("data-deletion", event));
  assert.equal(deleted.status, 200);
  const receipt = await deleted.json();
  assert.match(receipt.confirmation_code, /^[a-f0-9]{32}$/);
  assert.equal(receipt.url, `${origin}/api/connections/meta/deletion-status/${receipt.confirmation_code}`);
  await assert.rejects(connections.get(owner.principal, result.connection.id), { code: "NOT_FOUND" });
  const repeated = await lifecycleApi(callback("data-deletion", event));
  assert.deepEqual(await repeated.json(), receipt);
  const status = await lifecycleApi(new Request(receipt.url));
  assert.deepEqual(await status.json(), { status: "COMPLETED" });
  const page = await lifecycleApi(new Request(receipt.url, { headers: { accept: "text/html" } }));
  assert.match(await page.text(), /Request status: COMPLETED/);
  const retained = await db.adProxyExecution.findUniqueOrThrow({ where: { id: mixed.id }, include: { invocations: true } });
  assert.equal(retained.invocations.length, 2);
  assert.ok(retained.invocations.some((i) => i.platform === "GOOGLE" && i.authorizationId === googleGrant.id));
  assert.ok(retained.invocations.some((i) => i.platform === "META" && i.connectionMode === "LIVE" && i.authorizationId === liveGrant.id));
  assert.deepEqual(retained.responsePayload, { results: [googleResult, liveResult], providerDataRemoved: true });
  assert.deepEqual(retained.requestPayload, { targets: [googleResult, liveResult] });
  assert.equal((await connections.get(owner.principal, googleGrant.id)).status, "CONNECTED");
  assert.equal((await connections.get(owner.principal, liveGrant.id)).status, "CONNECTED");
  const independent = await db.providerAuthorization.findMany({ where: { provider: "GOOGLE" } });
  assert.ok(independent.length > 0);
  const otherMode = await db.providerAuthorization.findMany({ where: { provider: "META", connectionMode: "LIVE" } });
  assert.ok(otherMode.length > 0);
  const unknown = await lifecycleApi(callback("data-deletion", signed("9999", secret, clock.getTime() / 1000)));
  assert.equal(unknown.status, 200);
  assert.equal(JSON.stringify(await unknown.json()).includes("9999"), false);
  assert.equal((await lifecycleApi(new Request(`${origin}/api/connections/meta/deletion-status/${"0".repeat(32)}`))).status, 404);
});

after(async () => { await db?.$disconnect(); await mock?.stop(); if (directory) await rm(directory, { recursive: true, force: true }); });
