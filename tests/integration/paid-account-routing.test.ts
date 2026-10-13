import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../../apps/web/src/generated/prisma/client";
import { CustomerAuth, type CustomerPrincipal } from "../../apps/web/src/server/auth/customerAuth";
import { CredentialVault } from "../../apps/web/src/server/security/credentialVault";
import { CustomerConnections } from "../../apps/web/src/server/connections/customerConnections";
import { ProviderConnectionState } from "../../apps/web/src/server/connections/providerConnectionState";
import { GoogleConnectionService } from "../../apps/web/src/server/connections/googleConnectionApi";
import { MetaConnectionService } from "../../apps/web/src/server/connections/metaConnectionApi";
import { MetaLifecycleStore } from "../../apps/web/src/server/connections/metaLifecycleStore";
import { PaidAccountRouting, createPaidAccountRoutingApi } from "../../apps/web/src/server/connections/paidAccountRouting";
import { GoogleAdsClient } from "../../apps/web/src/server/providers/googleAds";
import { MetaAdsClient } from "../../apps/web/src/server/providers/metaAds";
import { AdapterRegistry } from "../../packages/core/src/adapters/AdapterRegistry";
import { MetaAdsAdapter } from "../../packages/core/src/adapters/MetaAdsAdapter";
import { executeAcrossPlatforms } from "../../packages/core/src/adapters/executeAcrossPlatforms";
import type { PlatformAccount, PlatformUserAccount } from "../../packages/core/src/adapters/types";
import { applyConnectionMigrations } from "../support/test-database";
import { startMockoon } from "../support/mockoon";

let directory: string, db: PrismaClient, auth: CustomerAuth, connections: CustomerConnections,
  state: ProviderConnectionState, google: GoogleConnectionService, meta: MetaConnectionService,
  metaClient: MetaAdsClient, googleMock: Awaited<ReturnType<typeof startMockoon>>,
  metaMock: Awaited<ReturnType<typeof startMockoon>>;
const clock = new Date("2026-10-13T12:00:00Z"), origin = "https://launchpad.test";
before(async () => {
  [googleMock, metaMock] = await Promise.all([startMockoon("tests/mockoon/google-ads.json"), startMockoon("tests/mockoon/meta-ads.json")]);
  directory = await mkdtemp(join(tmpdir(), "paid-routing-"));
  const url = `file:${join(directory, "test.db")}`, sqlite = createClient({ url });
  await applyConnectionMigrations(sqlite); sqlite.close();
  db = new PrismaClient({ adapter: new PrismaLibSql({ url }) });
  const vault = new CredentialVault({ test: Buffer.alloc(32, 27).toString("base64") }, "test");
  auth = new CustomerAuth(db, { origin }, () => clock);
  connections = new CustomerConnections(db, auth, vault, () => clock);
  state = new ProviderConnectionState(db, auth, vault, () => clock);
  const gc = new GoogleAdsClient({ clientId: "mock-google-client", clientSecret: "mock-client-secret",
    redirectUri: `${origin}/api/connections/google/callback`, mockoonEnabled: true, mockoonBaseUrl: googleMock.origin }, () => clock);
  google = new GoogleConnectionService(auth, connections, state, gc, "mock", () => clock);
  metaClient = new MetaAdsClient({ appId: "123", appSecret: "fixture-app-secret", configId: "456",
    redirectUri: `${origin}/api/connections/meta/callback`, testBaseUrl: metaMock.origin, now: () => clock });
  meta = new MetaConnectionService(auth, connections, state, metaClient, "mock", () => clock);
});
async function customer(name: string) {
  const email = `${name}@example.test`, password = "paid account routing test password";
  await auth.provisionCustomer({ email, name, password });
  const login = await auth.login(email, password), cookie = login.cookie.split(";")[0];
  const principal = await auth.requireSession(new Request(origin, { headers: { cookie } }));
  return { principal, cookie, request: (body: unknown) => new Request(`${origin}/api/ads/readiness`, {
    method: "POST", headers: { cookie, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }) };
}
function routing(overrides: Partial<{ google: () => Pick<GoogleConnectionService, "readSmoke">; meta: () => Pick<MetaConnectionService, "readSmoke"> }> = {}, mode: "mock" | "live" = "mock", database = db) {
  return new PaidAccountRouting(auth, connections, { google: () => google, meta: () => meta, ...overrides }, mode, database, () => clock);
}
async function selected(name: string, both = false) {
  const owner = await customer(name);
  const finish = async (service: MetaConnectionService | GoogleConnectionService) => {
    const start = await service.start(owner.principal);
    return service.complete(owner.principal, new URL(start.authorizationUrl).searchParams.get("state")!, "success");
  };
  const m = await finish(meta), md = m.connection.destinations.find((d) => d.externalId === "111")!;
  await meta.selectAccount(owner.principal, m.connection.id, md.id);
  if (!both) return { owner, m, md, g: undefined, gd: undefined };
  const g = await finish(google), gd = g.connection.destinations.find((d) => d.externalId === "400")!;
  await google.selectAccount(owner.principal, g.connection.id, gd.id, "100");
  return { owner, m, md, g, gd };
}
function deferred() {
  let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

test("explicit selected Google and Meta destinations read through Mockoon and save sanitized provenance", async () => {
  const { owner, m, md, g, gd } = await selected("routing-both", true);
  const api = createPaidAccountRoutingApi(auth, routing());
  const response = await api(owner.request({ destinationIds: [gd!.id, md.id] }));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const result = await response.json();
  assert.equal(result.mode, "mock"); assert.equal(result.success, true); assert.equal(result.partial, false);
  assert.equal(result.writesEnabled, false);
  assert.deepEqual(result.outcomes.map((o: { provider: string; canWrite: string; canRead: boolean }) => [o.provider, o.canRead, o.canWrite]), [["GOOGLE", true, "DISABLED"], ["META", true, "DISABLED"]]);
  assert.equal(result.outcomes[0].account.externalId, "400"); assert.equal(result.outcomes[1].campaigns[0].externalId, "9001");
  const saved = await db.adProxyExecution.findUniqueOrThrow({ where: { id: result.executionId }, include: { invocations: true } });
  assert.deepEqual(saved.invocations.map((i) => [i.authorizationId, i.destinationId, i.connectionMode]), [[g!.connection.id, gd!.id, "MOCK"], [m.connection.id, md.id, "MOCK"]]);
  assert.doesNotMatch(JSON.stringify([result, saved]), /long_success|mock-access|mock-refresh|Ciphertext|fixture-app-secret/);
});

test("all IDs preflight before any provider call, with no empty, duplicate, foreign or unselected fallback", async () => {
  const { owner, m, md } = await selected("routing-preflight"), other = await selected("routing-foreign");
  let calls = 0;
  const route = routing({ meta: () => ({ readSmoke: async (...args) => { calls++; return meta.readSmoke(...args); } }) });
  const unselected = m.connection.destinations.find((d) => d.externalId === "222")!;
  for (const ids of [[], [md.id, md.id], [md.id, other.md.id], [md.id, unselected.id], [md.id, "unknown"], Array.from({length: 26}, (_, i) => `${i}`), [md.id, 2], [""], [" "]]) {
    await assert.rejects(route.readSelected(owner.principal, ids as string[]));
  }
  assert.equal(calls, 0);
  const api = createPaidAccountRoutingApi(auth, route);
  assert.equal((await api(new Request(`${origin}/api/ads/readiness`, { method: "POST" }))).status, 401);
  assert.equal((await api(new Request(`${origin}/api/ads/readiness`, { method: "POST", headers: { cookie: owner.cookie, Origin: "https://evil.test" } }))).status, 403);
  assert.equal((await api(owner.request({ destinationIds: [md.id], accessToken: "forged" }))).status, 400);
  assert.equal(calls, 0);
});

test("mode, capability, provider, scopes and availability reject the entire mixed request before reads", async () => {
  const { owner, m, md, g, gd } = await selected("routing-policy", true);
  let calls = 0;
  const route = routing({ google: () => ({ readSmoke: async (...args) => { calls++; return google.readSmoke(...args); } }),
    meta: () => ({ readSmoke: async (...args) => { calls++; return meta.readSmoke(...args); } }) });
  for (const patch of [{ connectionMode: "LIVE" }, { capability: "SOCIAL" as const }, { provider: "TIKTOK" as const }, { scopes: [] }]) {
    const before = await db.providerAuthorization.findUniqueOrThrow({ where: { id: m.connection.id } });
    await db.providerAuthorization.update({ where: { id: m.connection.id }, data: patch });
    await assert.rejects(route.readSelected(owner.principal, [gd!.id, md.id]));
    await db.providerAuthorization.update({ where: { id: m.connection.id }, data: { provider: before.provider, capability: before.capability, scopes: before.scopes!, connectionMode: before.connectionMode } });
  }
  await db.connectionDestination.update({ where: { id: md.id }, data: { available: false } });
  await assert.rejects(route.readSelected(owner.principal, [gd!.id, md.id]));
  await assert.rejects(routing({}, "live").readSelected(owner.principal, [gd!.id]), { code: "CONNECTION_MODE_MISMATCH" });
  assert.equal(calls, 0);
});

test("Google selected manager role failure is partial and never falls back to another discovered root", async () => {
  const { owner, md, g, gd } = await selected("routing-manager", true);
  await google.selectAccount(owner.principal, g!.connection.id, gd!.id, "200");
  const fixture = JSON.parse(await readFile("tests/mockoon/google-ads.json", "utf8"));
  for (const route of fixture.routes) for (const response of route.responses)
    if (response.label?.startsWith("Campaign report")) for (const rule of response.rules)
      if (rule.target === "header" && rule.modifier === "login-customer-id") rule.value = "^100$";
  const path = join(directory, "denied-manager.json"); await writeFile(path, JSON.stringify(fixture));
  const denied = await startMockoon(path);
  try {
    const client = new GoogleAdsClient({ clientId: "mock-google-client", clientSecret: "mock-client-secret",
      redirectUri: `${origin}/api/connections/google/callback`, mockoonEnabled: true, mockoonBaseUrl: denied.origin }, () => clock);
    const service = new GoogleConnectionService(auth, connections, state, client, "mock", () => clock);
    const result = await routing({ google: () => service }).readSelected(owner.principal, [gd!.id, md.id]);
    assert.equal(result.success, false); assert.equal(result.partial, true);
    assert.equal(result.outcomes[0].error?.code, "PROVIDER_PERMISSION_DENIED");
    assert.equal(result.outcomes[0].account, undefined); assert.equal(result.outcomes[0].campaigns, undefined);
    assert.equal(result.outcomes[1].success, true);
    const current = await connections.get(owner.principal, g!.connection.id);
    assert.deepEqual(current.destinations.find((d) => d.id === gd!.id)!.selectedContext, { loginCustomerId: "200" });
  } finally { await denied.stop(); }
});

test("fresh Meta role/status loss removes selection and cannot produce readiness success", async () => {
  for (const token of ["lost-role", "disabled-account"]) {
    const { owner, m, md } = await selected(`routing-${token}`);
    const grant = await state.grant(owner.principal, m.connection.id, "META");
    await connections.updateCredentials(m.connection.id, grant.credentialVersion, { accessToken: token, scopes: grant.scopes, expiresAt: grant.expiresAt });
    const result = await routing().readSelected(owner.principal, [md.id]);
    assert.equal(result.success, false); assert.equal(result.outcomes[0].canRead, false);
    assert.equal(result.outcomes[0].account, undefined);
    assert.equal((await connections.get(owner.principal, m.connection.id)).destinations.find((d) => d.id === md.id)!.selected, false);
  }
});

test("fresh Google suspension persists unavailable state and discards otherwise successful campaign reads", async () => {
  const { owner, g, gd } = await selected("routing-suspension", true);
  const fixture = JSON.parse(await readFile("tests/mockoon/google-ads.json", "utf8"));
  for (const route of fixture.routes) for (const response of route.responses)
    response.body = response.body.replace(/("customer(?:Client)?"\s*:\s*\{[^{}]*"status"\s*:\s*)"ENABLED"/g, '$1"SUSPENDED"');
  const path = join(directory, "suspended-routing.json"); await writeFile(path, JSON.stringify(fixture));
  const suspended = await startMockoon(path);
  try {
    const client = new GoogleAdsClient({ clientId: "mock-google-client", clientSecret: "mock-client-secret",
      redirectUri: `${origin}/api/connections/google/callback`, mockoonEnabled: true, mockoonBaseUrl: suspended.origin }, () => clock);
    const service = new GoogleConnectionService(auth, connections, state, client, "mock", () => clock);
    const result = await routing({ google: () => service }).readSelected(owner.principal, [gd!.id]);
    assert.equal(result.success, false); assert.equal(result.outcomes[0].account, undefined); assert.equal(result.outcomes[0].campaigns, undefined);
    const destination = (await connections.get(owner.principal, g!.connection.id)).destinations.find((d) => d.id === gd!.id)!;
    assert.equal(destination.available, false); assert.equal(destination.selected, false);
    assert.equal((destination.metadata as { status: string }).status, "SUSPENDED");
  } finally { await suspended.stop(); }
});

test("Google token renewal uses the exact new credential version and keeps writes disabled", async () => {
  const { owner, g, gd } = await selected("routing-refresh", true);
  const grant = await state.grant(owner.principal, g!.connection.id, "GOOGLE");
  await connections.updateCredentials(g!.connection.id, grant.credentialVersion, { accessToken: "mock-access", refreshToken: "mock-refresh", scopes: grant.scopes, expiresAt: new Date(clock.getTime() - 1) });
  const result = await routing().readSelected(owner.principal, [gd!.id]);
  assert.equal(result.success, true); assert.equal(result.outcomes[0].canWrite, "DISABLED");
  assert.equal((await connections.get(owner.principal, g!.connection.id)).credentialVersion, grant.credentialVersion + 2);
});

test("expired Meta grants require reconnect and cannot refresh or expose stale account results", async () => {
  const { owner, m, md } = await selected("routing-meta-expiry");
  const grant = await state.grant(owner.principal, m.connection.id, "META");
  await connections.updateCredentials(m.connection.id, grant.credentialVersion, { accessToken: "long_success", scopes: grant.scopes, expiresAt: new Date(clock.getTime() - 1) });
  await assert.rejects(routing().readSelected(owner.principal, [md.id]), { code: "RECONNECT_REQUIRED" });
});

for (const change of ["disconnect", "deselect", "renew", "scope", "logout"] as const) test(`post-read ${change} invalidates successful provider data`, async () => {
  const { owner, m, md } = await selected(`routing-race-${change}`), read = deferred(), release = deferred();
  const route = routing({ meta: () => ({ readSmoke: async (...args) => { const result = await meta.readSmoke(...args); read.resolve(); await release.promise; return result; } }) });
  const pending = route.readSelected(owner.principal, [md.id]); await read.promise;
  if (change === "disconnect") await connections.disconnect(owner.principal, m.connection.id);
  if (change === "deselect") await connections.selectDestination(owner.principal, md.id, false);
  if (change === "renew") { const grant = await state.grant(owner.principal, m.connection.id, "META"); await connections.updateCredentials(m.connection.id, grant.credentialVersion, { accessToken: "long_success", scopes: grant.scopes, expiresAt: grant.expiresAt }); }
  if (change === "scope") await db.providerAuthorization.update({ where: { id: m.connection.id }, data: { scopes: [] } });
  if (change === "logout") await auth.logout(owner.principal);
  release.resolve();
  if (change === "logout") await assert.rejects(pending, { code: "UNAUTHENTICATED" });
  else { const result = await pending; assert.equal(result.success, false); assert.equal(result.outcomes[0].account, undefined); assert.equal(result.outcomes[0].campaigns, undefined); }
});

test("Google manager context changing after HTTP reads cannot publish results from the previous root", async () => {
  const { owner, g, gd } = await selected("routing-context-race", true), read = deferred(), release = deferred();
  const pending = routing({ google: () => ({ readSmoke: async (...args) => { const result = await google.readSmoke(...args); read.resolve(); await release.promise; return result; } }) }).readSelected(owner.principal, [gd!.id]);
  await read.promise; await google.selectAccount(owner.principal, g!.connection.id, gd!.id, "200"); release.resolve();
  const result = await pending; assert.equal(result.outcomes[0].error?.code, "STALE_CREDENTIALS"); assert.equal(result.outcomes[0].campaigns, undefined);
});

test("transactional final persistence rechecks reconnect and deletion after the last provider check", async () => {
  for (const change of ["delete", "renew"] as const) {
    const owner = await customer(`routing-final-${change}`);
    const isolated = await isolatedGrant(owner.principal, "444", "routing-token-a", change === "delete" ? "7001" : "7002");
    const m = { connection: isolated.grant }, md = isolated.destination;
    let intercepted = false;
    const guardedDb = new Proxy(db, { get(target, property) {
      if (property === "$transaction") return async (...args: Parameters<PrismaClient["$transaction"]>) => {
        if (!intercepted) {
          intercepted = true;
          if (change === "delete") await new MetaLifecycleStore(db, { origin, mode: "mock" }, () => clock).deleteData("7001");
          else { const grant = await state.grant(owner.principal, m.connection.id, "META"); await connections.updateCredentials(m.connection.id, grant.credentialVersion, { accessToken: "long_success", scopes: grant.scopes, expiresAt: grant.expiresAt }); }
        }
        return target.$transaction(...args);
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    const count = await db.adProxyExecution.count({ where: { ownerId: owner.principal.userId } });
    await assert.rejects(routing({}, "mock", guardedDb).readSelected(owner.principal, [md.id]), { code: "STALE_CREDENTIALS" });
    assert.equal(await db.adProxyExecution.count({ where: { ownerId: owner.principal.userId } }), count);
    assert.equal(await db.adPlatformInvocation.count({ where: { authorizationId: m.connection.id } }), 0);
  }
});

test("unknown provider failures never expose raw responses, bearer credentials or internal exceptions", async () => {
  const { owner, md } = await selected("routing-sanitize");
  const result = await routing({ meta: () => ({ readSmoke: async (...args) => { await meta.readSmoke(...args); throw new Error("routing-token-a secret provider body long_success"); } }) }).readSelected(owner.principal, [md.id]);
  assert.equal(result.outcomes[0].error?.code, "PROVIDER_REQUEST_FAILED");
  const saved = await db.adProxyExecution.findUniqueOrThrow({ where: { id: result.executionId }, include: { invocations: true } });
  assert.doesNotMatch(JSON.stringify([result, saved]), /routing-token-a|secret provider body|long_success/);
});

async function isolatedGrant(principal: CustomerPrincipal, externalId: string, accessToken: string, subject: string) {
  const oauth = meta.oauth, attempt = await connections.beginOAuth(principal, oauth);
  const grant = await connections.completeAuthorization(principal, attempt.state, oauth, { providerUserId: subject,
    externalGrantId: subject, connectionMode: "MOCK", accessToken, scopes: [...metaClient.scopes], expiresAt: new Date(clock.getTime() + 3600000) });
  const account = await metaClient.readAccount(accessToken, externalId);
  await state.synchronize(principal, grant.id, grant.credentialVersion, [{ externalId, kind: "AD_ACCOUNT", name: account.name,
    currency: account.currency, timezone: account.timezone, available: true, metadata: { accountStatus: 1, userTasks: account.userTasks, canRead: true, canWrite: "ALLOWED" } }]);
  const destination = (await connections.get(principal, grant.id)).destinations[0];
  await meta.selectAccount(principal, grant.id, destination.id);
  return { grant, destination };
}

test("same-provider concurrent accounts preserve distinct bearer and advertiser contexts over HTTP", async () => {
  const owner = await customer("routing-isolated");
  const a = await isolatedGrant(owner.principal, "444", "routing-token-a", "3001"), b = await isolatedGrant(owner.principal, "555", "routing-token-b", "3002");
  const result = await routing().readSelected(owner.principal, [a.destination.id, b.destination.id]);
  assert.equal(result.success, true);
  assert.deepEqual(result.outcomes.map((o) => [o.account!.externalId, o.campaigns![0].externalId]), [["444", "9444"], ["555", "9555"]]);
  await assert.rejects(metaClient.readAccount("routing-token-a", "555"), { code: "MISSING_PERMISSION" });
});

test("adapter factories isolate concurrent mutable account state and sanitize singleton failures", async () => {
  const read = deferred(); let entered = 0;
  class ReadAdapter extends MetaAdsAdapter {
    private selectedId = "";
    async connect(account: PlatformAccount) { await super.connect(account); this.selectedId = account.externalId; }
    async campaigns() { entered++; if (entered === 2) read.resolve(); await read.promise; return metaClient.readCampaigns(this.accessToken, this.selectedId); }
  }
  const registry = new AdapterRegistry(); registry.registerFactory("META", () => new ReadAdapter());
  const accounts: PlatformUserAccount[] = [{ id: "a", userId: "fixture", platform: "META", externalId: "444", accessToken: "routing-token-a" },
    { id: "b", userId: "fixture", platform: "META", externalId: "555", accessToken: "routing-token-b" }];
  const results = await executeAcrossPlatforms(accounts, (adapter) => (adapter as ReadAdapter).campaigns(), registry);
  assert.deepEqual(results.map((r) => [r.accountId, r.success, r.data?.[0].id]), [["a", true, "9444"], ["b", true, "9555"]]);
  const instance = new ReadAdapter(); const broken = new AdapterRegistry(); broken.registerFactory("META", () => instance);
  const failures = await executeAcrossPlatforms(accounts, async () => { throw new Error("Bearer private-token raw provider failure"); }, broken);
  assert.ok(failures.every((r) => !r.success && r.error?.code === "ACCOUNT_REQUEST_FAILED"));
  assert.doesNotMatch(JSON.stringify(failures), /private-token|raw provider/);
  const old = new AdapterRegistry(); old.register(instance);
  const missing = await executeAcrossPlatforms(accounts, async () => assert.fail("singleton invoked"), old);
  assert.ok(missing.every((r) => !r.success));
});

after(async () => { await db?.$disconnect(); await Promise.all([googleMock?.stop(), metaMock?.stop()]); if (directory) await rm(directory, { recursive: true, force: true }); });
