import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient } from "@libsql/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../../apps/web/src/generated/prisma/client";
import { CustomerAuth } from "../../apps/web/src/server/auth/customerAuth";
import { CustomerConnections, credentialContext } from "../../apps/web/src/server/connections/customerConnections";
import { renewLinkedInPublishing } from "../../apps/web/src/server/connections/linkedinRenewal";
import { CredentialVault } from "../../apps/web/src/server/security/credentialVault";
import { SocialProviderFailure } from "../../apps/web/src/server/social/types";
import { LinkedInClient, LinkedInError, LINKEDIN_MEMBER_SCOPES, type LinkedInConfig } from "../../apps/web/src/server/providers/linkedin";
import { applyConnectionMigrations } from "../support/test-database";
import { startMockoon } from "../support/mockoon";

let mock: Awaited<ReturnType<typeof startMockoon>>;
before(async () => { mock = await startMockoon("tests/mockoon/linkedin.json"); });
after(async () => { await mock?.stop(); });
const scopes = [...LINKEDIN_MEMBER_SCOPES, "r_member_social"];
function gate() { let release!: () => void; const promise = new Promise<void>((done) => { release = done; }); return { release, promise }; }

/** Real SDK OAuth/renewal HTTP and isolated SQLite, with no publication or live approval claims. */
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "linkedin-renewal-runtime-"));
  const url = `file:${join(directory, "test.sqlite")}`, sql = createClient({ url });
  await applyConnectionMigrations(sql); sql.close();
  const db = new PrismaClient({ adapter: new PrismaLibSql({ url }) });
  let clock = new Date("2026-10-13T12:00:00Z"); const now = () => clock;
  const config: LinkedInConfig = { clientId: "li-client", clientSecret: "fixture-li-secret", scopes,
    redirectUri: "https://launchpad.test/api/connections/linkedin/callback", now, mdpRefreshEnabled: true,
    mockoonEnabled: true, mockoonBaseUrl: mock.origin };
  const vault = new CredentialVault({ fixture: Buffer.alloc(32, 97).toString("base64") }, "fixture");
  const auth = new CustomerAuth(db, { origin: "https://launchpad.test" }, now);
  const connections = new CustomerConnections(db, auth, vault, now);
  await auth.provisionCustomer({ name: "LinkedIn renewal fixture", email: "li-renewal@example.test", password: "independent approved refresh fixture password" });
  const login = await auth.login("li-renewal@example.test", "independent approved refresh fixture password");
  const principal = await auth.requireSession(new Request(auth.origin, { headers: { cookie: login.cookie.split(";")[0] } }));
  const oauth = { provider: "LINKEDIN" as const, capability: "SOCIAL" as const, pkce: false, scopes, redirectUri: config.redirectUri };
  const attempt = await connections.beginOAuth(principal, oauth);
  const verified = await new LinkedInClient(config).exchangeCode({ code: "mdp-code" });
  const grant = await connections.completeAuthorization(principal, attempt.state, oauth, { ...verified, connectionMode: "MOCK" });
  const captured = await db.providerAuthorization.findUniqueOrThrow({ where: { id: grant.id } });
  const request = { ownerId: principal.userId, authorizationId: captured.id, generation: captured.generation,
    credentialVersion: captured.credentialVersion, verifyCurrent: async () => {} };
  return { db, auth, principal, connections, vault, config, now, captured, request, oauth,
    advance: (milliseconds: number) => { clock = new Date(clock.getTime() + milliseconds); },
    close: async () => { await db.$disconnect(); await rm(directory, { force: true, recursive: true }); } };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function parent(q: Fixture) { return q.db.providerAuthorization.findUniqueOrThrow({ where: { id: q.captured.id } }); }
function plaintext(q: Fixture, value: string, kind: "access" | "refresh") {
  return q.vault.decrypt(value, credentialContext(q.principal.userId, q.captured.id, kind));
}
async function responseFixture(kind: "token503" | "token429" | "introspection429" | "read-loss" | "write-loss" | "wrong-subject") {
  const directory = await mkdtemp(join(tmpdir(), "li-renewal-http-"));
  const fixture = JSON.parse(await readFile("tests/mockoon/linkedin.json", "utf8"));
  const route = fixture.routes.find((r: { endpoint: string }) => r.endpoint === "oauth/v2/accessToken");
  const response = route.responses.find((r: { label: string }) => r.label === "Actual MDP refresh");
  if (kind === "token503" || kind === "token429") {
    response.statusCode = kind === "token503" ? 503 : 429;
    response.body = JSON.stringify({ error: kind === "token503" ? "internal_error" : "rate_limit_exceeded" });
  } else if (kind === "wrong-subject") {
    response.body = JSON.stringify({ ...JSON.parse(response.body), access_token: "other-token" });
  } else {
    const inspect = fixture.routes.find((r: { endpoint: string }) => r.endpoint === "oauth/v2/introspectToken")
      .responses.find((r: { label: string }) => r.label === "mdp-token");
    if (kind === "introspection429") {
      inspect.statusCode = 429; inspect.body = JSON.stringify({ error: "rate_limit_exceeded" });
    } else {
      const withheld = kind === "read-loss" ? "r_member_social" : "w_member_social";
      inspect.body = JSON.stringify({ ...JSON.parse(inspect.body), scope: scopes.filter((scope) => scope !== withheld).join(",") });
    }
  }
  const file = join(directory, "fixture.json"); await writeFile(file, JSON.stringify(fixture));
  const server = await startMockoon(file);
  return { ...server, close: async () => { await server.stop(); await rm(directory, { force: true, recursive: true }); } };
}

test("approved MDP renewal persists actual rotated token and preserves the original refresh deadline, then adopts without HTTP", async () => {
  const q = await setup(); let requests = 0, guards = 0;
  try {
    q.advance(3600_000);
    const config = { ...q.config, beforeRequest: async () => { requests++; } };
    const request = { ...q.request, verifyCurrent: async () => { guards++; } };
    const renewed = await renewLinkedInPublishing(q.db, q.vault, config, request);
    assert.equal(renewed.providerUserId, "member-a"); assert.deepEqual(new Set(renewed.scopes), new Set(scopes));
    assert.equal(renewed.refreshToken, "mdp-refresh-rotated"); assert.equal(requests, 3); assert.equal(guards, 4);
    const row = await parent(q);
    assert.equal(plaintext(q, row.refreshCiphertext!, "refresh"), "mdp-refresh-rotated");
    assert.equal(row.refreshExpiresAt?.getTime(), q.captured.refreshExpiresAt?.getTime());
    assert.equal(row.credentialVersion, q.captured.credentialVersion + 1);
    await renewLinkedInPublishing(q.db, q.vault, config, request);
    assert.equal(requests, 3); assert.equal((await parent(q)).credentialVersion, row.credentialVersion);
    assert.equal(await q.db.socialCredentialRenewalLease.count(), 0);
  } finally { await q.close(); }
});

test("concurrent approved callers share one guarded SDK exchange and adopt only its durable winner", async () => {
  const q = await setup(), entered = gate(), finish = gate(); let boundaries = 0;
  try {
    const config = { ...q.config, beforeRequest: async () => {
      if (++boundaries === 2) { entered.release(); await finish.promise; }
    } };
    const work = renewLinkedInPublishing(q.db, q.vault, config, q.request); await entered.promise;
    await assert.rejects(renewLinkedInPublishing(q.db, q.vault, config, q.request),
      (error: unknown) => error instanceof SocialProviderFailure && error.kind === "TRANSIENT" && error.definitive);
    assert.equal(boundaries, 2); finish.release(); await work;
    const winner = await renewLinkedInPublishing(q.db, q.vault, config, q.request);
    assert.equal(boundaries, 3); assert.equal(winner.refreshToken, "mdp-refresh-rotated");
    assert.equal((await parent(q)).credentialVersion, q.captured.credentialVersion + 1);
    assert.equal(await q.db.socialCredentialRenewalLease.count(), 0);
  } finally { finish.release(); await q.close(); }
});

test("an enabled MDP flag without a real stored refresh token cannot manufacture or exchange credentials", async () => {
  const q = await setup(); let requests = 0;
  try {
    await q.db.providerAuthorization.update({ where: { id: q.captured.id }, data: { refreshCiphertext: null } });
    await assert.rejects(renewLinkedInPublishing(q.db, q.vault, { ...q.config,
      beforeRequest: async () => { requests++; } }, q.request), { code: "RECONNECT_REQUIRED" });
    assert.equal(requests, 0); assert.equal(await q.db.socialCredentialRenewalLease.count(), 0);
    assert.equal((await parent(q)).refreshCiphertext, null);
  } finally { await q.close(); }
});

for (const enabled of [false, undefined]) {
  test(`MDP flag ${String(enabled)} cannot exchange or manufacture a refresh grant`, async () => {
    const q = await setup(); let requests = 0;
    try {
      await assert.rejects(renewLinkedInPublishing(q.db, q.vault, { ...q.config, mdpRefreshEnabled: enabled,
        beforeRequest: async () => { requests++; } }, q.request), { code: "RECONNECT_REQUIRED" });
      assert.equal(requests, 0); assert.equal(await q.db.socialCredentialRenewalLease.count(), 0);
      assert.equal((await parent(q)).credentialVersion, q.captured.credentialVersion);
    } finally { await q.close(); }
  });
}

for (const kind of ["token503", "introspection429", "read-loss", "write-loss", "wrong-subject"] as const) {
  test(`real HTTP ${kind} during MDP rotation cannot restore or retry the old refresh token`, async () => {
    const q = await setup(), server = await responseFixture(kind); let requests = 0;
    try {
      await assert.rejects(renewLinkedInPublishing(q.db, q.vault, { ...q.config, mockoonBaseUrl: server.origin,
        beforeRequest: async () => { requests++; } }, q.request), { code: "RECONNECT_REQUIRED" });
      assert.equal(requests, kind === "token503" ? 1 : kind === "wrong-subject" ? 3 : 2);
      const row = await parent(q); assert.equal(row.status, "RECONNECT_REQUIRED"); assert.equal(row.refreshCiphertext, null);
      await assert.rejects(renewLinkedInPublishing(q.db, q.vault, { ...q.config, mockoonBaseUrl: server.origin,
        beforeRequest: async () => { requests++; } }, q.request), { code: "STALE_CREDENTIALS" });
      assert.ok((await q.db.socialCredentialRenewalLease.findUniqueOrThrow({ where: { authorizationId: row.id } })).startedAt);
    } finally { await server.close(); await q.close(); }
  });
}

test("real first-token429 is safely retryable without overwriting credentials or retaining an ambiguous lease", async () => {
  const q = await setup(), server = await responseFixture("token429"); let requests = 0;
  try {
    await assert.rejects(renewLinkedInPublishing(q.db, q.vault, { ...q.config, mockoonBaseUrl: server.origin,
      beforeRequest: async () => { requests++; } }, q.request),
      (error: unknown) => error instanceof SocialProviderFailure && error.kind === "RATE_LIMIT" && error.definitive);
    assert.equal(requests, 1); assert.equal(await q.db.socialCredentialRenewalLease.count(), 0);
    assert.equal((await parent(q)).status, "CONNECTED");
    assert.equal(plaintext(q, (await parent(q)).refreshCiphertext!, "refresh"), "mdp-refresh");
    await renewLinkedInPublishing(q.db, q.vault, q.config, q.request);
    assert.equal(plaintext(q, (await parent(q)).refreshCiphertext!, "refresh"), "mdp-refresh-rotated");
  } finally { await server.close(); await q.close(); }
});

for (const expiry of ["missing", "expired"] as const) {
  test(`${expiry} actual refresh expiry prevents SDK HTTP`, async () => {
    const q = await setup(); let requests = 0;
    try {
      await q.db.providerAuthorization.update({ where: { id: q.captured.id }, data: {
        refreshExpiresAt: expiry === "missing" ? null : new Date(q.now().getTime() - 1) } });
      await assert.rejects(renewLinkedInPublishing(q.db, q.vault, { ...q.config,
        beforeRequest: async () => { requests++; } }, q.request), { code: "RECONNECT_REQUIRED" });
      assert.equal(requests, 0);
    } finally { await q.close(); }
  });
}

test("disconnect after real token rotation prevents introspection HTTP and stale result persistence", async () => {
  const q = await setup(), entered = gate(), finish = gate(); let boundaries = 0;
  try {
    const work = renewLinkedInPublishing(q.db, q.vault, { ...q.config, beforeRequest: async () => {
      if (++boundaries === 2) { entered.release(); await finish.promise; }
    } }, q.request);
    const outcome = work.then(() => undefined, (error: unknown) => error); await entered.promise;
    await q.connections.disconnect(q.principal, q.captured.id); finish.release();
    assert.ok(await outcome instanceof Error); assert.equal(boundaries, 2);
    const row = await parent(q); assert.equal(row.status, "DISCONNECTED"); assert.equal(row.refreshCiphertext, null);
    assert.equal(await q.db.connectionAuditEvent.count({ where: { authorizationId: row.id, action: "SOCIAL_ROTATING_CREDENTIALS_RENEWED" } }), 0);
  } finally { finish.release(); await q.close(); }
});

test("mode mismatch and caller revocation prevent SDK HTTP without adopting unrelated credentials", async () => {
  const q = await setup(); let requests = 0;
  try {
    const config = { ...q.config, beforeRequest: async () => { requests++; } };
    await q.db.providerAuthorization.update({ where: { id: q.captured.id }, data: { connectionMode: "LIVE" } });
    await assert.rejects(renewLinkedInPublishing(q.db, q.vault, config, q.request), { code: "STALE_CREDENTIALS" });
    await q.db.providerAuthorization.update({ where: { id: q.captured.id }, data: { connectionMode: "MOCK" } });
    const cancelled = new Error("Private caller cancellation");
    await assert.rejects(renewLinkedInPublishing(q.db, q.vault, config, { ...q.request,
      verifyCurrent: async () => { throw cancelled; } }), (error: unknown) => error === cancelled);
    assert.equal(requests, 0);
    await assert.rejects(renewLinkedInPublishing(q.db, q.vault, { ...config, mockoonBaseUrl: undefined }, q.request), { code: "INVALID_CONFIG" });
  } finally { await q.close(); }
});

test("a local typed429 guard after actual token200 cannot release or safely retry its consumed refresh token", async () => {
  const q = await setup(); let boundaries = 0;
  try {
    await assert.rejects(renewLinkedInPublishing(q.db, q.vault, { ...q.config, beforeRequest: async () => {
      // Reaching the second SDK boundary proves the real token POST returned successfully.
      // Throw before introspection and before the durable request counter can advance.
      if (++boundaries === 2) throw new LinkedInError("PROVIDER_RATE_LIMITED", 429, true, false);
    } }, q.request), { code: "RECONNECT_REQUIRED" });
    assert.equal(boundaries, 2);
    const row = await parent(q); assert.equal(row.status, "RECONNECT_REQUIRED");
    assert.equal(row.refreshCiphertext, null); assert.equal(row.accessCiphertext, null);
    const lease = await q.db.socialCredentialRenewalLease.findUniqueOrThrow({ where: { authorizationId: row.id } });
    assert.equal(lease.requestCount, 1); assert.ok(lease.startedAt);
    assert.equal(await q.db.connectionAuditEvent.count({ where: {
      authorizationId: row.id, action: "SOCIAL_ROTATING_CREDENTIALS_RENEWED" } }), 0);
    await assert.rejects(renewLinkedInPublishing(q.db, q.vault, { ...q.config,
      beforeRequest: async () => { boundaries++; } }, q.request), { code: "STALE_CREDENTIALS" });
    assert.equal(boundaries, 2);
  } finally { await q.close(); }
});
