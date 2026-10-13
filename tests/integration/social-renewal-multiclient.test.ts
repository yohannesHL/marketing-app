import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../../apps/web/src/generated/prisma/client";
import { CustomerAuth } from "../../apps/web/src/server/auth/customerAuth";
import { CustomerConnections, credentialContext } from "../../apps/web/src/server/connections/customerConnections";
import { CredentialVault } from "../../apps/web/src/server/security/credentialVault";
import { SocialCredentialRenewalState, type VerifiedRotatedSocialGrant } from "../../apps/web/src/server/connections/socialCredentialRenewalState";
import { SocialProviderFailure } from "../../apps/web/src/server/social/types";
import { applyConnectionMigrations } from "../support/test-database";
import { startMockoon } from "../support/mockoon";
import { renewTikTokPublishing } from "../../apps/web/src/server/connections/tiktokRenewal";
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(done => { release = done; });
  return { promise, release };
}
async function fixture(actualTikTok = false) {
  const directory = await mkdtemp(join(tmpdir(), "renewal-multiclient-")), url = `file:${join(directory, "test.db")}`;
  const sql = createClient({ url }); await applyConnectionMigrations(sql); sql.close();
  const a = new PrismaClient({ adapter: new PrismaLibSql({ url }) }), b = new PrismaClient({ adapter: new PrismaLibSql({ url }) });
  let clock = new Date("2026-10-13T12:00:00Z"); const now = () => clock;
  const vault = new CredentialVault({ test: Buffer.alloc(32, 35).toString("base64") }, "test"), origin = "https://renewal.test";
  const auth = new CustomerAuth(a, { origin }, now), connections = new CustomerConnections(a, auth, vault, now);
  await auth.provisionCustomer({ name: "Renewal concurrency fixture", email: "renewal-concurrency@example.test", password: "independent renewal concurrency password" });
  const login = await auth.login("renewal-concurrency@example.test", "independent renewal concurrency password");
  const principal = await auth.requireSession(new Request(origin, { headers: { cookie: login.cookie.split(";")[0] } }));
  const scopes = ["user.info.basic", "video.publish"], oauth = { provider: "TIKTOK" as const, capability: "SOCIAL" as const,
    pkce: false, scopes, redirectUri: `${origin}/api/connections/tiktok/callback` };
  const attempt = await connections.beginOAuth(principal, oauth), grant = await connections.completeAuthorization(principal, attempt.state, oauth,
    { providerUserId: actualTikTok ? "open-id-a" : "fixture-subject", accessToken: actualTikTok ? "tt-access-a" : "fixture-old-access",
      refreshToken: actualTikTok ? "tt-refresh-a" : "fixture-old-refresh", scopes,
      expiresAt: new Date(clock.getTime() + 30000), refreshExpiresAt: new Date(clock.getTime() + 86400000), connectionMode: "MOCK" });
  const row = await a.providerAuthorization.findUniqueOrThrow({ where: { id: grant.id } });
  const request = { ownerId: row.userId, authorizationId: row.id, provider: "TIKTOK" as const, generation: row.generation,
    credentialVersion: row.credentialVersion, requiredScopes: scopes, verifyCaller: async () => {} };
  const result = (): VerifiedRotatedSocialGrant => ({ providerUserId: row.providerUserId, accessToken: "fixture-new-access", refreshToken: "fixture-new-refresh",
    scopes, expiresAt: new Date(clock.getTime() + 3600000), refreshExpiresAt: new Date(clock.getTime() + 25920000000) });
  return { a, b, vault, row, request, result, now,
    state: (db: PrismaClient) => new SocialCredentialRenewalState(db, vault, { mode: "mock", leaseMs: 1000, now }),
    advance: (ms: number) => { clock = new Date(clock.getTime() + ms); },
    close: async () => { await Promise.all([a.$disconnect(), b.$disconnect()]); await rm(directory, { recursive: true, force: true }); } };
}

test("independent SQLite clients competing before the writer produce one exchange and one bounded typed busy result", { timeout: 30000 }, async () => {
  const q = await fixture(), begin = gate(), entered = gate(), finish = gate(); let callers = 0, exchanges = 0;
  // The barrier is outside both transactions. A writer must never wait for a second reader to arrive.
  const verifyCaller = async () => { if (++callers <= 2) { if (callers === 2) begin.release(); await begin.promise; } };
  const request = { ...q.request, verifyCaller, exchange: async (snapshot: unknown, beforeRequest: () => Promise<void>) => {
    exchanges++; await beforeRequest(); entered.release(); await finish.promise; await beforeRequest(); return q.result(); } };
  const first = q.state(q.a).renew(request), second = q.state(q.b).renew(request);
  const outcomes = [first, second].map(work => work.then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error })));
  try {
    const loser = await Promise.race(outcomes);
    assert.ok(loser.error instanceof SocialProviderFailure); assert.equal(loser.error.kind, "TRANSIENT");
    assert.equal(loser.error.definitive, true); assert.equal(loser.error.retryAfterMs, 1000);
    await entered.promise; assert.equal(exchanges, 1);
    const lease = await q.b.socialCredentialRenewalLease.findUniqueOrThrow({ where: { authorizationId: q.row.id } });
    assert.equal(lease.requestCount, 1); assert.ok(lease.startedAt);
    finish.release();
    const settled = await Promise.all(outcomes); assert.equal(settled.filter(item => item.value).length, 1);
    const row = await q.b.providerAuthorization.findUniqueOrThrow({ where: { id: q.row.id } });
    assert.equal(row.status, "CONNECTED"); assert.equal(row.credentialVersion, q.row.credentialVersion + 1);
    assert.equal(row.refreshExpiresAt?.getTime(), q.result().refreshExpiresAt?.getTime());
    assert.equal(q.vault.decrypt(row.refreshCiphertext!, credentialContext(row.userId, row.id, "refresh")), "fixture-new-refresh");
    const adopted = await q.state(q.b).renew({ ...q.request, exchange: async () => { exchanges++; return q.result(); } });
    assert.equal(adopted.accessToken, "fixture-new-access"); assert.equal(exchanges, 1);
    assert.equal(await q.a.socialCredentialRenewalLease.count(), 0);
  } finally { begin.release(); finish.release(); await Promise.all(outcomes); await q.close(); }
});

test("actual TikTok SDK exchanges first, guards its identity HTTP and persists exact returned refresh lifetime", { timeout: 30000 }, async () => {
  const q = await fixture(true), mock = await startMockoon("tests/mockoon/tiktok.json"), counts: number[] = [];
  try {
    const grant = await renewTikTokPublishing(q.a, q.vault, { clientKey: "tt-client", clientSecret: "fixture-tt-secret",
      redirectUri: "https://renewal.test/api/connections/tiktok/callback", mockoonEnabled: true, mockoonBaseUrl: mock.origin, now: q.now,
      beforeRequest: async () => {
        const lease = await q.b.socialCredentialRenewalLease.findUniqueOrThrow({ where: { authorizationId: q.row.id } });
        counts.push(lease.requestCount);
      } }, { ownerId: q.row.userId, authorizationId: q.row.id, generation: q.row.generation,
      credentialVersion: q.row.credentialVersion, verifyCurrent: async () => {} });
    assert.deepEqual(counts, [0, 1]); assert.equal(grant.providerUserId, "open-id-a");
    const current = await q.b.providerAuthorization.findUniqueOrThrow({ where: { id: q.row.id } });
    assert.equal(current.credentialVersion, q.row.credentialVersion + 1);
    assert.equal(current.expiresAt?.getTime(), q.now().getTime() + 86400 * 1000);
    assert.equal(current.refreshExpiresAt?.getTime(), q.now().getTime() + 25920000 * 1000);
    assert.equal(q.vault.decrypt(current.refreshCiphertext!, credentialContext(current.userId, current.id, "refresh")), "tt-refresh-rotated");
    assert.equal(await q.a.socialCredentialRenewalLease.count(), 0);
  } finally { await mock.stop(); await q.close(); }
});

test("an independent recovery client cannot repeat a started expired rotating exchange or let its late holder persist", { timeout: 30000 }, async () => {
  const q = await fixture(), entered = gate(), finish = gate(); let exchanges = 0;
  const old = q.state(q.a).renew({ ...q.request, exchange: async (_snapshot, beforeRequest) => {
    exchanges++; await beforeRequest(); entered.release(); await finish.promise; return q.result(); } });
  const outcome = old.then(() => undefined, (error: unknown) => error);
  try {
    await entered.promise; q.advance(2000);
    await assert.rejects(q.state(q.b).renew({ ...q.request, exchange: async () => { exchanges++; return q.result(); } }), { code: "RECONNECT_REQUIRED" });
    finish.release(); assert.ok(await outcome instanceof Error); assert.equal(exchanges, 1);
    const row = await q.b.providerAuthorization.findUniqueOrThrow({ where: { id: q.row.id } });
    assert.equal(row.status, "RECONNECT_REQUIRED"); assert.equal(row.accessCiphertext, null); assert.equal(row.refreshCiphertext, null);
    const marker = await q.a.socialCredentialRenewalLease.findUniqueOrThrow({ where: { authorizationId: row.id } });
    assert.equal(marker.requestCount, 1); assert.ok(marker.startedAt);
  } finally { finish.release(); await outcome; await q.close(); }
});
