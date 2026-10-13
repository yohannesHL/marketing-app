import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../../apps/web/src/generated/prisma/client";
import { CustomerAuth } from "../../apps/web/src/server/auth/customerAuth";
import { CredentialVault } from "../../apps/web/src/server/security/credentialVault";
import { CustomerConnections } from "../../apps/web/src/server/connections/customerConnections";
import { ProviderConnectionState } from "../../apps/web/src/server/connections/providerConnectionState";
import { GoogleConnectionService, createGoogleConnectionApi } from "../../apps/web/src/server/connections/googleConnectionApi";
import { GoogleAdsClient } from "../../apps/web/src/server/providers/googleAds";
import { ProviderHttpError } from "../../apps/web/src/server/providers/providerHttp";
import { applyConnectionMigrations } from "../support/test-database";
import { startMockoon } from "../support/mockoon";

let directory: string;
let db: PrismaClient;
let auth: CustomerAuth;
let connections: CustomerConnections;
let state: ProviderConnectionState;
let service: GoogleConnectionService;
let api: ReturnType<typeof createGoogleConnectionApi>;
let mock: Awaited<ReturnType<typeof startMockoon>>;
let client: GoogleAdsClient;
let clock = new Date("2026-10-13T09:00:00Z");
const origin = "https://launchpad.test";

before(async () => {
  mock = await startMockoon("tests/mockoon/google-ads.json");
  directory = await mkdtemp(join(tmpdir(), "launchpad-google-"));
  const url = `file:${join(directory, "test.db")}`;
  const sqlite = createClient({ url });
  await applyConnectionMigrations(sqlite);
  sqlite.close();
  db = new PrismaClient({ adapter: new PrismaLibSql({ url }) });
  const vault = new CredentialVault({ test: Buffer.alloc(32, 17).toString("base64") }, "test");
  auth = new CustomerAuth(db, { origin }, () => clock);
  connections = new CustomerConnections(db, auth, vault, () => clock);
  state = new ProviderConnectionState(db, auth, vault, () => clock);
  client = new GoogleAdsClient({ clientId: "mock-google-client", clientSecret: "mock-client-secret",
    redirectUri: `${origin}/api/connections/google/callback`, mockoonEnabled: true, mockoonBaseUrl: mock.origin }, () => clock);
  service = new GoogleConnectionService(auth, connections, state, client, "mock", () => clock);
  api = createGoogleConnectionApi(auth, service);
});

async function customer(name: string) {
  const email = `${name}@example.test`;
  await auth.provisionCustomer({ name, email, password: "independent customer connection password" });
  const login = await auth.login(email, "independent customer connection password");
  const cookie = login.cookie.split(";")[0];
  const principal = await auth.requireSession(new Request(origin, { headers: { cookie } }));
  const request = (path: string, body: unknown = {}, method = "POST") => new Request(`${origin}${path}`, {
    method, headers: { cookie, Origin: origin, "Content-Type": "application/json" },
    ...(method !== "GET" ? { body: JSON.stringify(body) } : {}),
  });
  return { principal, cookie, request };
}

async function connected(name: string) {
  const owner = await customer(name);
  const start = await service.start(owner.principal);
  const stateValue = new URL(start.authorizationUrl).searchParams.get("state")!;
  const result = await service.complete(owner.principal, stateValue, "success");
  return { owner, result };
}

test("authenticated OAuth routes discover manager context and return no credentials", async () => {
  const alice = await customer("google-alice");
  assert.equal((await api(new Request(`${origin}/api/connections/google/start`, { method: "POST" }))).status, 401);
  assert.equal((await api(new Request(`${origin}/api/connections/google/start`, { method: "POST",
    headers: { cookie: alice.cookie, Origin: "https://other.test" } }))).status, 403);
  assert.equal((await api(alice.request("/api/connections/google/start", { accessToken: "forged" }))).status, 400);
  const response = await api(alice.request("/api/connections/google/start"));
  assert.equal(response.status, 200);
  const start = await response.json();
  const consent = await fetch(start.authorizationUrl, { redirect: "manual" });
  const callback = consent.headers.get("location")!;
  const finish = await api(new Request(callback, { headers: { cookie: alice.cookie } }));
  assert.equal(finish.status, 200);
  const result = await finish.json();
  assert.equal(result.mode, "mock");
  assert.equal(result.connection.connectionMode, "MOCK");
  assert.equal(result.connection.providerUserId, "google-sub-1");
  assert.equal(JSON.stringify(result).includes("mock-access"), false);
  assert.equal(JSON.stringify(result).includes("mock-refresh"), false);
  const advertiser = result.connection.destinations.find((d: { externalId: string }) => d.externalId === "400");
  assert.deepEqual(advertiser.metadata.contexts, [{ loginCustomerId: "100" }, { loginCustomerId: "200" }]);
  assert.equal(advertiser.metadata.canWrite, "UNKNOWN");
  const manager = result.connection.destinations.find((d: { externalId: string }) => d.externalId === "100");
  assert.equal(manager.available, false);
  await assert.rejects(connections.selectDestination(alice.principal, manager.id, true), { code: "RECONNECT_REQUIRED" });
  assert.equal((await api(new Request(callback, { headers: { cookie: alice.cookie } }))).status, 400);
  const smoke = await api(alice.request(`/api/connections/google/${result.connection.id}/check`, { destinationId: advertiser.id }));
  assert.equal(smoke.status, 200);
  assert.equal((await smoke.json()).canRead, true);
});

test("reconnect state belongs to an owned Google Ads connection and declined consent is consumed", async () => {
  const { owner, result } = await connected("google-reconnect");
  const bob = await customer("google-other");
  await assert.rejects(service.start(bob.principal, result.connection.id), { code: "NOT_FOUND" });
  const attempt = await service.start(owner.principal, result.connection.id);
  const nonce = new URL(attempt.authorizationUrl).searchParams.get("state")!;
  const denied = await api(owner.request(`/api/connections/google/callback?state=${nonce}&error=access_denied`, {}, "GET"));
  assert.equal(denied.status, 400);
  assert.equal((await denied.json()).code, "CONSENT_DENIED");
  await assert.rejects(service.complete(owner.principal, nonce, "success"), { code: "INVALID_OAUTH_STATE" });
  const retry = await service.start(owner.principal, result.connection.id);
  const same = await service.complete(owner.principal, new URL(retry.authorizationUrl).searchParams.get("state")!, "no-refresh");
  assert.equal(same.connection.id, result.connection.id);
});

test("a duplicate callback cannot exchange again or cancel the winning authorization", async () => {
  const owner = await customer("google-duplicate-callback");
  let signal!: () => void;
  let release!: () => void;
  let exchanges = 0;
  const reached = new Promise<void>((resolve) => { signal = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const singleUse = new Proxy(client, { get(target, key) {
    if (key === "exchangeCode") return async (input: Parameters<GoogleAdsClient["exchangeCode"]>[0]) => {
      if (++exchanges > 1)
        throw new ProviderHttpError("RECONNECT_REQUIRED", 409, "The authorization code was already exchanged.");
      const grant = await target.exchangeCode(input);
      signal();
      await held;
      return grant;
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const concurrent = new GoogleConnectionService(auth, connections, state, singleUse, "mock", () => clock);
  const attempt = await concurrent.start(owner.principal);
  const nonce = new URL(attempt.authorizationUrl).searchParams.get("state")!;
  const winner = concurrent.complete(owner.principal, nonce, "success")
    .then(() => ({ succeeded: true }), (error: { code: string }) => ({ succeeded: false, code: error.code }));
  await reached;
  let duplicateCode: string | undefined;
  try { await concurrent.complete(owner.principal, nonce, "success"); }
  catch (error) { duplicateCode = (error as { code: string }).code; }
  finally { release(); }
  assert.deepEqual(await winner, { succeeded: true });
  assert.equal(duplicateCode, "INVALID_OAUTH_STATE");
  assert.equal(exchanges, 1);
  assert.equal((await connections.list(owner.principal)).length, 1);
});

test("simultaneous OAuth claims reserve the same attempt only once", { timeout: 10_000 }, async () => {
  const owner = await customer("google-concurrent-claim");
  const attempt = await service.start(owner.principal);
  const nonce = new URL(attempt.authorizationUrl).searchParams.get("state")!;
  let reads = 0;
  let release!: () => void;
  const bothRead = new Promise<void>((resolve) => { release = resolve; });
  const delayedDb = new Proxy(db, { get(target, key) {
    if (key === "oAuthAttempt") return new Proxy(target.oAuthAttempt, { get(model, method) {
      if (method === "findFirst") return async (args: Parameters<typeof model.findFirst>[0]) => {
        const snapshot = await model.findFirst(args);
        if (++reads === 2) release();
        await bothRead;
        return snapshot;
      };
      return Reflect.get(model, method);
    } });
    return Reflect.get(target, key);
  } });
  const concurrent = new CustomerConnections(delayedDb, auth,
    new CredentialVault({ test: Buffer.alloc(32, 17).toString("base64") }, "test"), () => clock);
  const claims = await Promise.allSettled([
    concurrent.claimOAuthExchange(owner.principal, nonce, service.oauth),
    concurrent.claimOAuthExchange(owner.principal, nonce, service.oauth),
  ]);
  assert.equal(claims.filter((claim) => claim.status === "fulfilled").length, 1);
  const loser = claims.find((claim) => claim.status === "rejected");
  assert.equal(loser?.reason.code, "INVALID_OAUTH_STATE");
  const winner = claims.find((claim) => claim.status === "fulfilled")!;
  await state.cancelOAuth(owner.principal, nonce, service.oauth, winner.value.exchangeClaimToken);
});

test("claimed OAuth work requires the matching private token for completion or cancellation", async () => {
  const owner = await customer("google-claim-owner");
  const attempt = await service.start(owner.principal);
  const nonce = new URL(attempt.authorizationUrl).searchParams.get("state")!;
  const claim = await connections.claimOAuthExchange(owner.principal, nonce, service.oauth);
  const grant = await client.exchangeCode({ code: "success", codeVerifier: claim.codeVerifier! });
  await assert.rejects(connections.getOAuthExchangeContext(owner.principal, nonce, service.oauth), { code: "INVALID_OAUTH_STATE" });
  await assert.rejects(connections.completeAuthorization(owner.principal, nonce, service.oauth, grant), { code: "INVALID_OAUTH_STATE" });
  await assert.rejects(connections.completeAuthorization(owner.principal, nonce, service.oauth, grant, "wrong-token"), { code: "INVALID_OAUTH_STATE" });
  await state.cancelOAuth(owner.principal, nonce, service.oauth);
  await state.cancelOAuth(owner.principal, nonce, service.oauth, "wrong-token");
  await connections.completeAuthorization(owner.principal, nonce, service.oauth, grant, claim.exchangeClaimToken);
  const next = await service.start(owner.principal);
  const nextNonce = new URL(next.authorizationUrl).searchParams.get("state")!;
  const nextClaim = await connections.claimOAuthExchange(owner.principal, nextNonce, service.oauth);
  await state.cancelOAuth(owner.principal, nextNonce, service.oauth, nextClaim.exchangeClaimToken);
  await assert.rejects(connections.completeAuthorization(owner.principal, nextNonce, service.oauth, grant, nextClaim.exchangeClaimToken), { code: "INVALID_OAUTH_STATE" });
});

test("disconnect while provider discovery is in flight cannot restore authorization", async () => {
  const { owner, result } = await connected("google-disconnect");
  let signal!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((done) => { signal = done; });
  const held = new Promise<void>((done) => { release = done; });
  const delayed = new Proxy(client, { get(target, key) {
    if (key === "discoverAccounts") return async (token: string) => {
      const rows = await target.discoverAccounts(token); signal(); await held; return rows;
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  const slow = new GoogleConnectionService(auth, connections, state, delayed, "mock", () => clock);
  const attempt = await slow.start(owner.principal, result.connection.id);
  const denied = assert.rejects(slow.complete(owner.principal, new URL(attempt.authorizationUrl).searchParams.get("state")!, "success"), { code: "INVALID_OAUTH_STATE" });
  await reached;
  try { await connections.disconnect(owner.principal, result.connection.id); }
  finally { release(); }
  await denied;
  assert.equal((await connections.get(owner.principal, result.connection.id)).status, "DISCONNECTED");
});

test("expired access renews with subject verification; revoked refresh disables future work", async () => {
  const { owner, result } = await connected("google-renew");
  const snapshot = await state.grant(owner.principal, result.connection.id, "GOOGLE");
  await connections.updateCredentials(result.connection.id, snapshot.credentialVersion, {
    accessToken: "mock-access", refreshToken: "mock-refresh", scopes: snapshot.scopes,
    expiresAt: new Date(clock.getTime() - 1),
  });
  await service.refreshAccounts(owner.principal, result.connection.id);
  assert.ok((await state.grant(owner.principal, result.connection.id, "GOOGLE")).expiresAt! > clock);
  const fresh = await state.grant(owner.principal, result.connection.id, "GOOGLE");
  await connections.updateCredentials(result.connection.id, fresh.credentialVersion, {
    accessToken: "mock-access", refreshToken: "revoked-refresh", scopes: fresh.scopes,
    expiresAt: new Date(clock.getTime() - 1),
  });
  await assert.rejects(service.refreshAccounts(owner.principal, result.connection.id), { code: "RECONNECT_REQUIRED" });
  const disabled = await connections.get(owner.principal, result.connection.id);
  assert.equal(disabled.status, "RECONNECT_REQUIRED");
  assert.ok(disabled.destinations.every((d) => !d.selected));
});

test("account checks cannot cross customers, destinations, or provider modes", async () => {
  const { owner, result } = await connected("google-check-owner");
  const bob = await customer("google-check-other");
  const account = result.connection.destinations.find((d) => d.available)!;
  await assert.rejects(service.readSmoke(bob.principal, result.connection.id, account.id), { code: "NOT_FOUND" });
  await assert.rejects(service.readSmoke(owner.principal, result.connection.id, "another-destination"), { code: "NOT_FOUND" });
  const live = new GoogleConnectionService(auth, connections, state, client, "live", () => clock);
  await assert.rejects(live.refreshAccounts(owner.principal, result.connection.id), { code: "CONNECTION_MODE_MISMATCH" });
  await assert.rejects(state.synchronize(owner.principal, result.connection.id, 0, []), { code: "STALE_CREDENTIALS" });
  assert.equal((await connections.get(owner.principal, result.connection.id)).destinations.length, result.connection.destinations.length);
});

test("fresh OAuth start cannot replace a same-subject connection from another mode", async () => {
  const { owner, result } = await connected("google-mode-upsert");
  await db.providerAuthorization.update({ where: { id: result.connection.id }, data: { connectionMode: "LIVE" } });
  const start = await service.start(owner.principal);
  await assert.rejects(service.complete(owner.principal, new URL(start.authorizationUrl).searchParams.get("state")!, "success"), { code: "CONNECTION_MODE_MISMATCH" });
  assert.equal((await connections.get(owner.principal, result.connection.id)).connectionMode, "LIVE");
});

test("discovery from an older callback cannot attach to a newer reconnect version", async () => {
  const owner = await customer("google-concurrent-reconnect");
  let signal!: () => void;
  let release!: () => void;
  const completed = new Promise<void>((done) => { signal = done; });
  const held = new Promise<void>((done) => { release = done; });
  const delayed = new Proxy(connections, { get(target, key) {
    if (key === "completeAuthorization") return async (...args: Parameters<CustomerConnections["completeAuthorization"]>) => {
      const result = await target.completeAuthorization(...args); signal(); await held; return result;
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  const slow = new GoogleConnectionService(auth, delayed, state, client, "mock", () => clock);
  const first = await slow.start(owner.principal);
  const rejected = assert.rejects(slow.complete(owner.principal, new URL(first.authorizationUrl).searchParams.get("state")!, "success"), { code: "STALE_CREDENTIALS" });
  await completed;
  try {
    const second = await service.start(owner.principal);
    await service.complete(owner.principal, new URL(second.authorizationUrl).searchParams.get("state")!, "success");
  } finally { release(); }
  await rejected;
  assert.equal((await connections.list(owner.principal))[0].credentialVersion, 2);
});

test("freshly suspended accounts become unavailable and cancel queued work while read diagnostics remain possible", async () => {
  const { owner, result } = await connected("google-suspended-selection");
  const account = result.connection.destinations.find((d) => d.externalId === "400")!;
  await service.selectAccount(owner.principal, result.connection.id, account.id, "100");
  const job = await connections.queueOperation(owner.principal, account.id, "ADS", ["https://www.googleapis.com/auth/adwords"]);
  const fixture = JSON.parse(await readFile("tests/mockoon/google-ads.json", "utf8")) as {
    routes: { responses: { body: string }[] }[];
  };
  for (const route of fixture.routes) for (const response of route.responses)
    response.body = response.body.replace(/("customer(?:Client)?"\s*:\s*\{[^{}]*"status"\s*:\s*)"ENABLED"/g, '$1"SUSPENDED"');
  const fixturePath = join(directory, "suspended-google.json");
  await writeFile(fixturePath, JSON.stringify(fixture));
  const suspended = await startMockoon(fixturePath);
  try {
    const changedClient = new GoogleAdsClient({ clientId: "mock-google-client", clientSecret: "mock-client-secret",
      redirectUri: `${origin}/api/connections/google/callback`, mockoonEnabled: true, mockoonBaseUrl: suspended.origin }, () => clock);
    const changedService = new GoogleConnectionService(auth, connections, state, changedClient, "mock", () => clock);
    const fresh = await changedClient.verifyAccount("mock-access", { customerId: "400", loginCustomerId: "100" });
    assert.equal(fresh.status, "SUSPENDED");
    await assert.rejects(changedService.selectAccount(owner.principal, result.connection.id, account.id, "100"), { code: "ACCOUNT_NOT_AVAILABLE" });
    const destination = (await connections.get(owner.principal, result.connection.id)).destinations.find((d) => d.id === account.id)!;
    assert.equal(destination.available, false);
    assert.equal(destination.selected, false);
    assert.equal((destination.metadata as { status: string }).status, "SUSPENDED");
    await assert.rejects(connections.runOperation(job.id, async () => assert.fail("suspended account received queued work")), { code: "OPERATION_UNAVAILABLE" });
    const diagnostic = await changedService.readSmoke(owner.principal, result.connection.id, account.id);
    assert.equal(diagnostic.account.status, "SUSPENDED");
    assert.equal(diagnostic.canRead, true);
    assert.equal(diagnostic.canWrite, "UNKNOWN");
  } finally { await suspended.stop(); }
});

test("manager selection is reverified and retained through queued operation context", async () => {
  const { owner, result } = await connected("google-context-selection");
  const account = result.connection.destinations.find((d) => d.externalId === "400")!;
  await assert.rejects(service.selectAccount(owner.principal, result.connection.id, account.id, "999"), { code: "INVALID_ACCOUNT_CONTEXT" });
  await service.selectAccount(owner.principal, result.connection.id, account.id, "200");
  const operation = await connections.queueOperation(owner.principal, account.id, "ADS", ["https://www.googleapis.com/auth/adwords"]);
  await connections.runOperation(operation.id, async (credentials) => {
    assert.deepEqual(credentials.selectedContext, { loginCustomerId: "200" });
    assert.equal(credentials.connectionMode, "MOCK");
  });
  assert.equal((await service.readSmoke(owner.principal, result.connection.id, account.id)).canRead, true);
  // A separate real HTTP fixture simulates report-role loss for the selected
  // root. The service must report it rather than switching to another root.
  const fixture = JSON.parse(await readFile("tests/mockoon/google-ads.json", "utf8"));
  for (const route of fixture.routes) {
    for (const response of route.responses) {
      if (!["Campaign report first page", "Campaign report second page"].includes(response.label)) continue;
      for (const rule of response.rules) {
        if (rule.target === "header" && rule.modifier === "login-customer-id") rule.value = "^100$";
      }
    }
  }
  const filename = join(directory, "report-role-loss.json");
  await writeFile(filename, JSON.stringify(fixture));
  const denied = await startMockoon(filename);
  try {
    const deniedClient = new GoogleAdsClient({ clientId: "mock-google-client", clientSecret: "mock-client-secret",
      redirectUri: `${origin}/api/connections/google/callback`, mockoonEnabled: true, mockoonBaseUrl: denied.origin }, () => clock);
    const deniedService = new GoogleConnectionService(auth, connections, state, deniedClient, "mock", () => clock);
    await assert.rejects(deniedService.readSmoke(owner.principal, result.connection.id, account.id), { code: "PROVIDER_PERMISSION_DENIED" });
    const current = await connections.get(owner.principal, result.connection.id);
    assert.deepEqual(current.destinations.find((item) => item.id === account.id)?.selectedContext, { loginCustomerId: "200" });
  } finally { await denied.stop(); }
  await service.selectAccount(owner.principal, result.connection.id, account.id, "100");
  assert.equal((await service.readSmoke(owner.principal, result.connection.id, account.id)).canRead, true);
});

after(async () => { await db?.$disconnect(); await mock?.stop(); if (directory) await rm(directory, { recursive: true, force: true }); });
