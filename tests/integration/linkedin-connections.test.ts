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
import { LinkedInConnectionState } from "../../apps/web/src/server/connections/linkedinConnectionState";
import { LinkedInConnectionService, createLinkedInConnectionApi } from "../../apps/web/src/server/connections/linkedinConnectionApi";
import { LinkedInClient, LINKEDIN_MEMBER_SCOPES, LINKEDIN_ORGANIZATION_SCOPES } from "../../apps/web/src/server/providers/linkedin";
import { linkedInScopes } from "../../apps/web/src/server/connections/linkedinRuntime";
import { applyConnectionMigrations } from "../support/test-database";
import { startMockoon } from "../support/mockoon";
let directory: string, db: PrismaClient, auth: CustomerAuth, connections: CustomerConnections, state: ProviderConnectionState,
 social: SocialConnectionState, fences: LinkedInConnectionState, service: LinkedInConnectionService, api: ReturnType<typeof createLinkedInConnectionApi>;
let mock: Awaited<ReturnType<typeof startMockoon>>; const clock = new Date("2026-10-13T12:00:00Z"), origin = "https://launchpad.test";
const memberScopes = [...LINKEDIN_MEMBER_SCOPES, "r_member_social"];
const config = (scopes: string[] = memberScopes) => ({ clientId: "li-client", clientSecret: "fixture-li-secret", redirectUri: `${origin}/api/connections/linkedin/callback`,
 scopes, version: "202609" as const, mockoonEnabled: true, mockoonBaseUrl: mock.origin, now: () => clock });
const build = (scopes = memberScopes, extra = {}) => new LinkedInConnectionService(auth, connections, state, social, fences, { ...config(scopes), ...extra }, "mock", () => clock);
before(async () => {
 mock = await startMockoon("tests/mockoon/linkedin.json"); directory = await mkdtemp(join(tmpdir(), "linkedin-connections-"));
 const url = `file:${join(directory, "test.db")}`, sql = createClient({ url }); await applyConnectionMigrations(sql); sql.close();
 db = new PrismaClient({ adapter: new PrismaLibSql({ url }) }); const vault = new CredentialVault({ test: Buffer.alloc(32, 94).toString("base64") }, "test");
 auth = new CustomerAuth(db, { origin }, () => clock); connections = new CustomerConnections(db, auth, vault, () => clock);
 state = new ProviderConnectionState(db, auth, vault, () => clock); social = new SocialConnectionState(db, auth, () => clock); fences = new LinkedInConnectionState(db, auth, () => clock);
 service = build(); api = createLinkedInConnectionApi(auth, service);
});
after(async () => { await mock?.stop(); await db?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });
async function customer(name: string) {
 const password = "independent linkedin connection fixture password"; await auth.provisionCustomer({ email: `${name}@example.test`, name, password });
 const login = await auth.login(`${name}@example.test`, password), cookie = login.cookie.split(";")[0];
 const principal = await auth.requireSession(new Request(origin, { headers: { cookie } }));
 const request = (path: string, body: unknown = {}, method = "POST") => new Request(`${origin}${path}`, { method, headers: { cookie, Origin: origin, "Content-Type": "application/json" }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
 return { principal, cookie, request };
}
async function connected(name: string, client = service, code = "member-code") {
 const owner = await customer(name), start = await client.start(owner.principal), value = new URL(start.authorizationUrl).searchParams.get("state")!;
 return { owner, value, result: await client.complete(owner.principal, value, code) };
}
test("LinkedIn connection uses explicit server scopes, SOCIAL identity and private-safe unselected member discovery", async () => {
 const owner = await customer("li-api");
 assert.equal((await api(new Request(`${origin}/api/connections/linkedin/start`, { method: "POST" }))).status, 401);
 assert.equal((await api(new Request(`${origin}/api/connections/linkedin/start`, { method: "POST", headers: { cookie: owner.cookie, Origin: "https://foreign.test" } }))).status, 403);
 assert.equal((await api(owner.request("/api/connections/linkedin/start", { scopes: ["forged"], accessToken: "forged" }))).status, 400);
 const response = await api(owner.request("/api/connections/linkedin/start")), start = await response.json(), url = new URL(start.authorizationUrl);
 assert.equal(url.searchParams.get("scope"), memberScopes.join(" ")); assert.equal(url.searchParams.has("code_challenge"), false);
 const result = await service.complete(owner.principal, url.searchParams.get("state")!, "member-code"), dest = result.connection.destinations[0];
 assert.equal(result.connection.provider, "LINKEDIN"); assert.equal(result.connection.capability, "SOCIAL"); assert.equal(result.connection.providerUserId, "member-a");
 assert.equal(dest.externalId, "urn:li:person:member-a"); assert.equal(dest.selected, false); assert.equal(dest.available, true); assert.equal((dest.metadata as any).canWrite, "ALLOWED");
 assert.doesNotMatch(JSON.stringify(result), /member-token|fixture-li-secret|Ciphertext|exchangeClaim|refreshExpiresAt/);
});
test("organization-only approved configuration discovers organic organization without member scope requirements or DSC authors", async () => {
 const client = build([...LINKEDIN_ORGANIZATION_SCOPES]), q = await connected("li-org", client, "organization-code");
 const member = q.result.connection.destinations.find(d => d.kind === "LINKEDIN_MEMBER")!, org = q.result.connection.destinations.find(d => d.kind === "LINKEDIN_ORGANIZATION")!;
 assert.equal(member.available, false); assert.equal((member.metadata as any).canWrite, "DENIED"); assert.equal(org.externalId, "urn:li:organization:123"); assert.equal(org.available, true);
 assert.equal(q.result.connection.destinations.some(d => d.externalId === "urn:li:organization:456"), false);
 const chosen = await client.refresh(q.owner.principal, q.result.connection.id, org.id, true); assert.equal(chosen.connection.destinations.find(d => d.id === org.id)!.selected, true);
 await assert.rejects(client.refresh(q.owner.principal, q.result.connection.id, member.id, true), { code: "MISSING_PERMISSION" });
});
test("self-serve write-only member remains blocked when restricted read confirmation is not approved", async () => {
 const client = build([...LINKEDIN_MEMBER_SCOPES]), q = await connected("li-selfserve", client, "selfserve-code"), destination = q.result.connection.destinations[0];
 assert.equal(destination.available, false); assert.equal((destination.metadata as any).canRead, false); assert.equal((destination.metadata as any).canWrite, "DENIED");
 await assert.rejects(client.refresh(q.owner.principal, q.result.connection.id, destination.id, true), { code: "READ_CAPABILITY_REQUIRED" });
 assert.equal((await connections.get(q.owner.principal, q.result.connection.id)).destinations[0].selected, false);
});
test("callback binds actual customer/session and consumes denied, missing-scope and replayed states", async () => {
 const a = await customer("li-state-a"), b = await customer("li-state-b"), start = await service.start(a.principal), value = new URL(start.authorizationUrl).searchParams.get("state")!;
 await assert.rejects(service.complete(b.principal, value, "member-code"), { code: "INVALID_OAUTH_STATE" });
 const login = await auth.login("li-state-a@example.test", "independent linkedin connection fixture password"), cookie = login.cookie.split(";")[0];
 const second = await auth.requireSession(new Request(origin, { headers: { cookie } }));
 await assert.rejects(service.complete(second, value, "member-code"), { code: "INVALID_OAUTH_STATE" });
 await assert.rejects(service.complete(a.principal, value, undefined, true), { code: "CONSENT_DENIED" });
 await assert.rejects(service.complete(a.principal, value, "member-code"), { code: "INVALID_OAUTH_STATE" });
 const missing = await service.start(a.principal), invalid = new URL(missing.authorizationUrl).searchParams.get("state")!;
 await assert.rejects(service.complete(a.principal, invalid, "missing-scope"), { code: "MISSING_PERMISSION" });
 assert.equal(await db.providerAuthorization.count({ where: { userId: a.principal.userId } }), 0);
 const q = await connected("li-replay"); await assert.rejects(service.complete(q.owner.principal, q.value, "member-code"), { code: "INVALID_OAUTH_STATE" });
});
test("overlapping callbacks claim once and failed reconnect cannot replace the original subject", async () => {
 const owner = await customer("li-overlap"); let release!: () => void, entered!: () => void;
 const gate = new Promise<void>(done => { release = done; }), started = new Promise<void>(done => { entered = done; }); let sends = 0;
 const controlled = build(memberScopes, { beforeRequest: async () => { if (++sends === 1) { entered(); await gate; } } });
 const start = await controlled.start(owner.principal), value = new URL(start.authorizationUrl).searchParams.get("state")!, winner = controlled.complete(owner.principal, value, "member-code");
 await started;
 try { await assert.rejects(controlled.complete(owner.principal, value, "member-code"), { code: "INVALID_OAUTH_STATE" }); assert.equal(sends, 1); } finally { release(); }
 const result = await winner, reconnect = await service.start(owner.principal, result.connection.id), reconnectState = new URL(reconnect.authorizationUrl).searchParams.get("state")!;
 await assert.rejects(service.complete(owner.principal, reconnectState, "wrong-subject"), { code: "PROVIDER_IDENTITY_MISMATCH" });
 const current = await state.grant(owner.principal, result.connection.id, "LINKEDIN", "SOCIAL"); assert.equal(current.providerUserId, "member-a"); assert.equal(current.credentialVersion, result.connection.credentialVersion);
});
test("fresh selection verifies author and rejects foreign author IDs, Ads grants, unsupported bodies and mode changes", async () => {
 const a = await connected("li-selection-a"), b = await connected("li-selection-b"), id = a.result.connection.id, dest = a.result.connection.destinations[0];
 await assert.rejects(service.refresh(a.owner.principal, id, b.result.connection.destinations[0].id, true), { code: "NOT_FOUND" });
 let sends = 0; const checked = build(memberScopes, { beforeRequest: async () => { sends++; } });
 const chosen = await checked.refresh(a.owner.principal, id, dest.id, true); assert.equal(chosen.connection.destinations[0].selected, true); assert.ok(sends >= 6);
 const local = createLinkedInConnectionApi(auth, checked);
 assert.equal((await local(a.owner.request(`/api/connections/linkedin/${id}/select`, { destinationId: dest.id, authorUrn: "urn:li:person:other" }))).status, 400);
 const live = new LinkedInConnectionService(auth, connections, state, social, fences, { ...config(), mockoonEnabled: undefined, mockoonBaseUrl: undefined }, "live", () => clock);
 await assert.rejects(live.refresh(a.owner.principal, id), { code: "CONNECTION_MODE_MISMATCH" });
 const oauth = { provider: "LINKEDIN" as const, capability: "ADS" as const, redirectUri: config().redirectUri, scopes: ["openid"], pkce: false }, attempt = await connections.beginOAuth(a.owner.principal, oauth);
 const ads = await connections.completeAuthorization(a.owner.principal, attempt.state, oauth, { providerUserId: "ads-actor", accessToken: "ads-token", scopes: oauth.scopes, connectionMode: "MOCK" });
 await assert.rejects(service.refresh(a.owner.principal, ads.id), { code: "NOT_FOUND" });
});
test("expired access requires actual MDP refresh expiry and injected serialized renewal; refreshed state retains private expiry", async () => {
 const q = await connected("li-no-renewal"), id = q.result.connection.id;
 await db.providerAuthorization.update({ where: { id }, data: { expiresAt: new Date(clock.getTime() + 1000) } });
 await assert.rejects(service.refresh(q.owner.principal, id), { code: "RECONNECT_REQUIRED" });
 const mdp = build(memberScopes, { mdpRefreshEnabled: true }), m = await connected("li-mdp", mdp, "mdp-code"), mid = m.result.connection.id;
 const original = await fences.snapshot(m.owner.principal, mid, m.result.connection.credentialVersion, "mock"); assert.equal(original.refreshExpiresAt?.getTime(), clock.getTime() + 86400000);
 await db.providerAuthorization.update({ where: { id: mid }, data: { expiresAt: new Date(clock.getTime() + 1000) } });
 let calls = 0;
 const renewing = new LinkedInConnectionService(auth, connections, state, social, fences, { ...config(), mdpRefreshEnabled: true }, "mock", () => clock, async request => {
  calls++; assert.equal(request.authorizationId, mid); await request.verifyCurrent();
  const old = await state.grant(m.owner.principal, mid, "LINKEDIN", "SOCIAL");
  // Seam coverage only: shared helper owns actual concurrent rotating-refresh coordination.
  const replacement = await new LinkedInClient({ ...config(), mdpRefreshEnabled: true, beforeRequest: request.verifyCurrent }).renewVerified({ providerUserId: request.providerUserId,
    refreshToken: old.refreshToken!, refreshExpiresAt: original.refreshExpiresAt!, scopes: old.scopes });
  await connections.updateCredentials(mid, request.credentialVersion, replacement);
 });
 const result = await renewing.refresh(m.owner.principal, mid); assert.equal(calls, 1); assert.ok(result.connection.credentialVersion > m.result.connection.credentialVersion);
 const refreshed = await state.grant(m.owner.principal, mid, "LINKEDIN", "SOCIAL"); assert.equal(refreshed.refreshToken, "mdp-refresh-rotated");
 assert.doesNotMatch(JSON.stringify(result), /mdp-token|mdp-refresh|refreshExpiresAt/);
 await db.providerAuthorization.update({ where: { id: mid }, data: { expiresAt: new Date(clock.getTime() + 1000), refreshExpiresAt: new Date(clock.getTime() - 1) } });
 await assert.rejects(renewing.refresh(m.owner.principal, mid), { code: "RECONNECT_REQUIRED" }); assert.equal(calls, 1);
});
test("every provider request fences ownership, session, credential version, generation and current mode", async () => {
 const q = await connected("li-fences"), id = q.result.connection.id, snap = await fences.snapshot(q.owner.principal, id, q.result.connection.credentialVersion, "mock");
 for (const patch of [{ credentialVersion: snap.credentialVersion + 1 }, { generation: snap.generation + 1 }, { mode: "live" as const }, { providerUserId: "member-b" }])
  await assert.rejects(fences.verifyCurrent(q.owner.principal, { ...snap, ...patch }), { code: "STALE_CREDENTIALS" });
 let sends = 0; const controlled = build(memberScopes, { beforeRequest: async () => { if (++sends === 2) await connections.disconnect(q.owner.principal, id); } });
 await assert.rejects(controlled.refresh(q.owner.principal, id, q.result.connection.destinations[0].id, true), { code: "STALE_CREDENTIALS" }); assert.equal(sends, 2);
 assert.equal((await connections.get(q.owner.principal, id)).destinations[0].selected, false);
 const a = await customer("li-logout-exchange"), guarded = build(memberScopes, { beforeRequest: async () => { await auth.logout(a.principal); } });
 const start = await guarded.start(a.principal), value = new URL(start.authorizationUrl).searchParams.get("state")!;
 await assert.rejects(guarded.complete(a.principal, value, "member-code"), { code: "UNAUTHENTICATED" }); assert.equal(await db.providerAuthorization.count({ where: { userId: a.principal.userId } }), 0);
});
test("expired/duplicate callbacks and actual LinkedIn denial codes use only safe fixed app redirects", async () => {
 for (const [index, error] of ["user_cancelled_login", "user_cancelled_authorize", "access_denied"].entries()) {
  const owner = await customer(`li-browser-${index}`), start = await service.start(owner.principal), value = new URL(start.authorizationUrl).searchParams.get("state")!;
  const response = await api(new Request(`${origin}/api/connections/linkedin/callback?state=${value}&error=${error}&error_description=private-message&code=private-code`, { headers: { cookie: owner.cookie, Accept: "text/html" } }));
  assert.equal(response.status, 303); assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("location"), `${origin}/connections?provider=linkedin&result=failed&error=CONSENT_DENIED`);
 }
 const owner = await customer("li-expired-state"), start = await service.start(owner.principal), value = new URL(start.authorizationUrl).searchParams.get("state")!;
 assert.equal((await api(owner.request(`/api/connections/linkedin/callback?state=${value}&state=forged&code=member-code`, {}, "GET"))).status, 400);
 await db.oAuthAttempt.updateMany({ where: { userId: owner.principal.userId }, data: { expiresAt: new Date(clock.getTime() - 1) } });
 await assert.rejects(service.complete(owner.principal, value, "member-code"), { code: "INVALID_OAUTH_STATE" });
});
test("configured scope whitelist and provider mode have no Ads, legacy, caller-selected or mock fallback", () => {
 assert.deepEqual(linkedInScopes({ LINKEDIN_SCOPES: JSON.stringify(LINKEDIN_ORGANIZATION_SCOPES) }), [...LINKEDIN_ORGANIZATION_SCOPES]);
 for (const value of [undefined, "invalid", "[]", JSON.stringify(["openid", "profile", "w_member_social", "r_ads"]), JSON.stringify(["openid", "profile", "w_member_social", "openid"])])
  assert.throws(() => linkedInScopes({ LINKEDIN_SCOPES: value }), { code: "INVALID_CONFIG" });
 assert.throws(() => new LinkedInConnectionService(auth, connections, state, social, fences, config(), "live"), { code: "INVALID_CONFIG" });
 assert.throws(() => build(memberScopes, { mockoonBaseUrl: "https://foreign.test", mockoonEnabled: true }), { code: "INVALID_CONFIG" });
});
test("changed server permission configuration cannot exchange a prior consent attempt", async () => {
 const owner = await customer("li-changed-scopes"), start = await service.start(owner.principal), value = new URL(start.authorizationUrl).searchParams.get("state")!;
 let sends = 0; const changed = build([...LINKEDIN_ORGANIZATION_SCOPES], { beforeRequest: async () => { sends++; } });
 await assert.rejects(changed.complete(owner.principal, value, "organization-code"), { code: "INVALID_OAUTH_STATE" }); assert.equal(sends, 0);
 assert.equal(await db.providerAuthorization.count({ where: { userId: owner.principal.userId } }), 0);
});
test("actual provider denial clears previously selected publishing access instead of retaining cached role approval", async () => {
 const orgClient = build([...LINKEDIN_ORGANIZATION_SCOPES]), q = await connected("li-revoked-role", orgClient, "organization-code"), id = q.result.connection.id;
 const target = q.result.connection.destinations.find(d => d.kind === "LINKEDIN_ORGANIZATION")!;
 await orgClient.refresh(q.owner.principal, id, target.id, true);
 const old = await state.grant(q.owner.principal, id, "LINKEDIN", "SOCIAL");
 await connections.updateCredentials(id, old.credentialVersion, { accessToken: "revoked-role-token", scopes: old.scopes, expiresAt: old.expiresAt });
 await assert.rejects(orgClient.refresh(q.owner.principal, id, target.id, true), { code: "ORGANIZATION_ROLE_REQUIRED" });
 const current = await connections.get(q.owner.principal, id); assert.equal(current.status, "CONNECTED"); assert.equal(current.destinations.find(d => d.id === target.id)!.selected, false);
 assert.equal(current.destinations.find(d => d.id === target.id)!.available, false);
});
