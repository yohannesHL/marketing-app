import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../../apps/web/src/generated/prisma/client";
import { CustomerAuth } from "../../apps/web/src/server/auth/customerAuth";
import { CredentialVault } from "../../apps/web/src/server/security/credentialVault";
import { CustomerConnections } from "../../apps/web/src/server/connections/customerConnections";
import { ProviderConnectionState } from "../../apps/web/src/server/connections/providerConnectionState";
import { SocialConnectionState } from "../../apps/web/src/server/connections/socialConnectionState";
import { TikTokCreatorState } from "../../apps/web/src/server/connections/tiktokCreatorState";
import { TikTokConnectionService, createTikTokConnectionApi } from "../../apps/web/src/server/connections/tiktokConnectionApi";
import { TIKTOK_SCOPES, creatorVersion, TikTokClient } from "../../apps/web/src/server/providers/tiktok";
import { applyConnectionMigrations } from "../support/test-database";
import { startMockoon } from "../support/mockoon";
let directory: string, db: PrismaClient, auth: CustomerAuth, connections: CustomerConnections, state: ProviderConnectionState,
 social: SocialConnectionState, creators: TikTokCreatorState, service: TikTokConnectionService, api: ReturnType<typeof createTikTokConnectionApi>, vault: CredentialVault;
let mock: Awaited<ReturnType<typeof startMockoon>>; let clock = new Date("2026-10-13T12:00:00Z"); const origin = "https://launchpad.test";
const config = () => ({ clientKey: "tt-client", clientSecret: "fixture-tt-secret", redirectUri: `${origin}/api/connections/tiktok/callback`,
 mockoonEnabled: true, mockoonBaseUrl: mock.origin, now: () => clock });
before(async () => {
 mock = await startMockoon("tests/mockoon/tiktok.json"); directory = await mkdtemp(join(tmpdir(), "tiktok-connections-"));
 const url = `file:${join(directory, "test.db")}`, sql = createClient({ url }); await applyConnectionMigrations(sql); sql.close();
 db = new PrismaClient({ adapter: new PrismaLibSql({ url }) }); vault = new CredentialVault({ test: Buffer.alloc(32, 83).toString("base64") }, "test");
 auth = new CustomerAuth(db, { origin }, () => clock); connections = new CustomerConnections(db, auth, vault, () => clock);
 state = new ProviderConnectionState(db, auth, vault, () => clock); social = new SocialConnectionState(db, auth, () => clock); creators = new TikTokCreatorState(db, auth, () => clock);
 service = new TikTokConnectionService(auth, connections, state, social, creators, config(), "mock", () => clock); api = createTikTokConnectionApi(auth, service);
});
after(async () => { await mock?.stop(); await db?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });
async function customer(name: string) {
 clock = new Date(clock.getTime() + 60001); // Independent synthetic OAuth cases share the fixture token; advance their quota window.
 const password = "independent tiktok connection fixture password"; await auth.provisionCustomer({ email: `${name}@example.test`, name, password });
 const login = await auth.login(`${name}@example.test`, password), cookie = login.cookie.split(";")[0];
 const principal = await auth.requireSession(new Request(origin, { headers: { cookie } }));
 const request = (path: string, body: unknown = {}, method = "POST") => new Request(`${origin}${path}`, { method, headers: { cookie, Origin: origin, "Content-Type": "application/json" }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
 return { principal, cookie, request };
}
async function connected(name: string) { const owner = await customer(name), start = await service.start(owner.principal), consentState = new URL(start.authorizationUrl).searchParams.get("state")!;
 return { owner, consentState, result: await service.complete(owner.principal, consentState, "success") }; }

test("TikTok connection API verifies SOCIAL identity, persists server-fetched creator version and rejects forged bodies", async () => {
 const owner = await customer("tt-oauth");
 assert.equal((await api(new Request(`${origin}/api/connections/tiktok/start`, { method: "POST" }))).status, 401);
 assert.equal((await api(new Request(`${origin}/api/connections/tiktok/start`, { method: "POST", headers: { cookie: owner.cookie, Origin: "https://foreign.test" } }))).status, 403);
 assert.equal((await api(owner.request("/api/connections/tiktok/start", { creator: {}, accessToken: "forged" }))).status, 400);
 const start = await service.start(owner.principal), value = new URL(start.authorizationUrl).searchParams.get("state")!;
 const response = await api(owner.request(`/api/connections/tiktok/callback?state=${value}&code=success`, {}, "GET")); assert.equal(response.status, 200);
 const body = await response.json(), destination = body.connection.destinations[0], metadata = destination.metadata.tiktokCreator;
 assert.equal(body.connection.capability, "SOCIAL"); assert.equal(body.connection.provider, "TIKTOK"); assert.deepEqual(body.connection.scopes, [...TIKTOK_SCOPES].sort());
 assert.equal(destination.externalId, "open-id-a"); assert.equal(destination.selected, false); assert.equal(metadata.openId, "open-id-a");
 assert.equal(metadata.authorizationId, body.connection.id); assert.equal(metadata.authorizationGeneration, 1); assert.equal(metadata.checkedAt, clock.toISOString());
 assert.equal(metadata.version, creatorVersion(metadata)); assert.ok(metadata.privacyLevels.includes("SELF_ONLY")); assert.equal(metadata.maxDurationSeconds, 300);
 assert.doesNotMatch(JSON.stringify(body), /tt-access|tt-refresh|fixture-tt-secret|Ciphertext|exchangeClaim/);
 assert.equal((await api(owner.request(`/api/connections/tiktok/${body.connection.id}/check`, { destinationId: destination.id, creatorInfoVersion: "forged" }))).status, 400);
});
test("TikTok callback state cannot cross customers, replay, or persist missing scopes and wrong verified subjects", async () => {
 const a = await customer("tt-state-a"), b = await customer("tt-state-b"), start = await service.start(a.principal), value = new URL(start.authorizationUrl).searchParams.get("state")!;
 await assert.rejects(service.complete(b.principal, value, "success"), { code: "INVALID_OAUTH_STATE" });
 await assert.rejects(service.complete(a.principal, value, undefined, true), { code: "CONSENT_DENIED" });
 await assert.rejects(service.complete(a.principal, value, "success"), { code: "INVALID_OAUTH_STATE" });
 const q = await connected("tt-replay"); await assert.rejects(service.complete(q.owner.principal, q.consentState, "success"), { code: "INVALID_OAUTH_STATE" });
 for (const [code, failure] of [["missing-scope", "MISSING_PERMISSION"], ["forged-subject", "PROVIDER_IDENTITY_MISMATCH"]]) {
  const s = await service.start(a.principal), v = new URL(s.authorizationUrl).searchParams.get("state")!; await assert.rejects(service.complete(a.principal, v, code), { code: failure });
  await assert.rejects(service.complete(a.principal, v, "success"), { code: "INVALID_OAUTH_STATE" });
 }
 assert.equal(await db.providerAuthorization.count({ where: { userId: a.principal.userId } }), 0);
});
test("fresh selection rejects foreign destinations, wrong modes and Ads-only grants; settings changes replace trusted snapshots", async () => {
 const a = await connected("tt-select-a"), b = await connected("tt-select-b"), id = a.result.connection.id, destination = a.result.connection.destinations[0];
 await assert.rejects(service.refresh(a.owner.principal, id, b.result.connection.destinations[0].id, true), { code: "NOT_FOUND" });
 const chosen = await service.refresh(a.owner.principal, id, destination.id, true); assert.equal(chosen.connection.destinations[0].selected, true);
 const previous = (destination.metadata as any).tiktokCreator.version;
 const row = await state.grant(a.owner.principal, id, "TIKTOK", "SOCIAL"); await connections.updateCredentials(id, row.credentialVersion, { accessToken: "tt-changed", refreshToken: "tt-refresh-a", scopes: [...TIKTOK_SCOPES], expiresAt: new Date(clock.getTime() + 3600000) });
 const changed = await service.refresh(a.owner.principal, id), trusted = (changed.connection.destinations[0].metadata as any).tiktokCreator;
 assert.notEqual(trusted.version, previous); assert.equal(trusted.nickname, "Changed creator name"); assert.equal(trusted.authorizationGeneration, 1);
 const live = new TikTokConnectionService(auth, connections, state, social, creators, { ...config(), mockoonBaseUrl: undefined, mockoonEnabled: undefined }, "live", () => clock);
 await assert.rejects(live.refresh(a.owner.principal, id), { code: "CONNECTION_MODE_MISMATCH" });
 const oauth = { provider: "TIKTOK" as const, capability: "ADS" as const, redirectUri: config().redirectUri, scopes: ["user.info.basic"], pkce: false }, attempt = await connections.beginOAuth(a.owner.principal, oauth);
 const ads = await connections.completeAuthorization(a.owner.principal, attempt.state, oauth, { providerUserId: "ads-actor", accessToken: "ads-token", scopes: oauth.scopes, connectionMode: "MOCK" });
 await assert.rejects(service.refresh(a.owner.principal, ads.id), { code: "NOT_FOUND" });
});
test("creator persistence fences actual ownership, subject, mode, generation, credential version and active session", async () => {
 const q = await connected("tt-fences"), id = q.result.connection.id, grant = await creators.snapshot(q.owner.principal, id, q.result.connection.credentialVersion, "mock");
 const creator = await new TikTokClient(config()).creatorInfo("tt-access-a", "open-id-a");
 for (const patch of [{ credentialVersion: grant.credentialVersion + 1 }, { generation: grant.generation + 1 }, { mode: "live" as const }])
  await assert.rejects(creators.persist(q.owner.principal, { ...grant, ...patch }, creator), { code: "STALE_CREDENTIALS" });
 await assert.rejects(creators.persist(q.owner.principal, { ...grant, providerUserId: "open-id-b" }, creator), { code: "INVALID_DISCOVERY" });
 await assert.rejects(creators.persist(q.owner.principal, grant, { ...creator, version: "a".repeat(64) }), { code: "INVALID_DISCOVERY" });
 await auth.logout(q.owner.principal); await assert.rejects(creators.persist(q.owner.principal, grant, creator), { code: "UNAUTHENTICATED" });
});
test("browser denial uses a safe app-only 303 without state, code, or provider messages", async () => {
 const owner = await customer("tt-browser"), start = await service.start(owner.principal), value = new URL(start.authorizationUrl).searchParams.get("state")!;
 const response = await api(new Request(`${origin}/api/connections/tiktok/callback?state=${value}&error=access_denied&error_description=private-message&code=private-code`, { headers: { cookie: owner.cookie, Accept: "text/html" } }));
 assert.equal(response.status, 303); assert.equal(response.headers.get("referrer-policy"), "no-referrer");
 assert.equal(response.headers.get("location"), `${origin}/connections?provider=tiktok&result=failed&error=CONSENT_DENIED`);
});
test("expired browser refresh fails closed without a rotating renewal callback", async () => {
 const q = await connected("tt-expiry"); await db.providerAuthorization.update({ where: { id: q.result.connection.id }, data: { expiresAt: new Date(clock.getTime() + 1000) } });
 await assert.rejects(service.refresh(q.owner.principal, q.result.connection.id), { code: "RECONNECT_REQUIRED" });
});

test("overlapping callbacks claim once and a loser cannot cancel the winning exchange", async () => {
 const owner = await customer("tt-double-callback"); let release!: () => void, entered!: () => void;
 const gate = new Promise<void>((done) => { release = done; }), started = new Promise<void>((done) => { entered = done; }); let sends = 0;
 const controlled = new TikTokConnectionService(auth, connections, state, social, creators,
  { ...config(), beforeRequest: async () => { sends++; if (sends === 1) { entered(); await gate; } } }, "mock", () => clock);
 const start = await controlled.start(owner.principal), value = new URL(start.authorizationUrl).searchParams.get("state")!;
 const winner = controlled.complete(owner.principal, value, "success"); await started;
 try { await assert.rejects(controlled.complete(owner.principal, value, "success"), { code: "INVALID_OAUTH_STATE" }); assert.equal(sends, 1); }
 finally { release(); }
 const result = await winner; assert.equal(result.connection.destinations[0].externalId, "open-id-a");
 assert.equal(await db.providerAuthorization.count({ where: { userId: owner.principal.userId, provider: "TIKTOK", capability: "SOCIAL" } }), 1);
});
test("logout during exchange fences every subsequent provider request and persists no grant", async () => {
 const owner = await customer("tt-logout-exchange"); let sends = 0;
 const guarded = new TikTokConnectionService(auth, connections, state, social, creators,
  { ...config(), beforeRequest: async () => { if (++sends === 1) await auth.logout(owner.principal); } }, "mock", () => clock);
 const start = await guarded.start(owner.principal), value = new URL(start.authorizationUrl).searchParams.get("state")!;
 await assert.rejects(guarded.complete(owner.principal, value, "success"), { code: "UNAUTHENTICATED" }); assert.equal(sends, 1);
 assert.equal(await db.providerAuthorization.count({ where: { userId: owner.principal.userId } }), 0);
});
test("reconnection verifies original identity and disconnect races cannot restore creator metadata", async () => {
 const q = await connected("tt-reconnect"); const start = await service.start(q.owner.principal, q.result.connection.id), value = new URL(start.authorizationUrl).searchParams.get("state")!;
 await assert.rejects(service.complete(q.owner.principal, value, "wrong-subject"), { code: "PROVIDER_IDENTITY_MISMATCH" });
 const row = await state.grant(q.owner.principal, q.result.connection.id, "TIKTOK", "SOCIAL");
 const snapshot = await creators.snapshot(q.owner.principal, row.id, row.credentialVersion, "mock"), creator = await new TikTokClient(config()).creatorInfo(row.accessToken!, row.providerUserId);
 await connections.disconnect(q.owner.principal, row.id);
 await assert.rejects(creators.persist(q.owner.principal, snapshot, creator), { code: "STALE_CREDENTIALS" });
 await assert.rejects(service.refresh(q.owner.principal, row.id), { code: "RECONNECT_REQUIRED" });
});
test("serialized renewal seam reloads current rotated credentials before creator discovery", async () => {
 const q = await connected("tt-renewal"), id = q.result.connection.id; await db.providerAuthorization.update({ where: { id }, data: { expiresAt: new Date(clock.getTime() + 1000) } });
 let calls = 0;
 const renewed = new TikTokConnectionService(auth, connections, state, social, creators, config(), "mock", () => clock, async (request) => {
  calls++; assert.equal(request.authorizationId, id); assert.equal(request.providerUserId, "open-id-a"); assert.equal(request.mode, "mock"); await request.verifyCurrent();
  // Tests the seam only: root's serialized helper owns the lease and rotating-token exchange contract.
  const grant = await state.grant(q.owner.principal, id, "TIKTOK", "SOCIAL");
  const replacement = await new TikTokClient({ ...config(), beforeRequest: request.verifyCurrent }).renewVerified({ providerUserId: request.providerUserId, refreshToken: grant.refreshToken! });
  await connections.updateCredentials(id, request.credentialVersion, replacement);
 });
 const result = await renewed.refresh(q.owner.principal, id); assert.equal(calls, 1); assert.ok(result.connection.credentialVersion > q.result.connection.credentialVersion);
 assert.equal((result.connection.destinations[0].metadata as any).tiktokCreator.authorizationGeneration, 1);
 const privateGrant = await state.grant(q.owner.principal, id, "TIKTOK", "SOCIAL"); assert.equal(privateGrant.refreshToken, "tt-refresh-rotated");
 assert.doesNotMatch(JSON.stringify(result), /tt-rotated|tt-refresh-rotated|fixture-tt-secret/);
});
