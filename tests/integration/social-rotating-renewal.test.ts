import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient } from "@libsql/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../../apps/web/src/generated/prisma/client";
import { CustomerAuth } from "../../apps/web/src/server/auth/customerAuth";
import { CustomerConnections, credentialContext } from "../../apps/web/src/server/connections/customerConnections";
import { CredentialVault } from "../../apps/web/src/server/security/credentialVault";
import { SocialPostService } from "../../apps/web/src/server/social/postService";
import { SocialProviderRegistry, SocialProviderFailure } from "../../apps/web/src/server/social/types";
import { SocialCredentialRenewalState, SocialRenewalExchangeError, type SocialRotatingRenewalRequest,
  type VerifiedRotatedSocialGrant } from "../../apps/web/src/server/connections/socialCredentialRenewalState";
import { applyConnectionMigrations } from "../support/test-database";

function gate() { let release!: () => void; const promise = new Promise<void>((done) => { release = done; }); return { promise, release }; }
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "social-rotating-renewal-"));
  const url = `file:${join(directory, "test.sqlite")}`, sql = createClient({ url });
  await applyConnectionMigrations(sql); sql.close(); const db = new PrismaClient({ adapter: new PrismaLibSql({ url }) });
  let clock = new Date("2026-10-13T12:00:00Z"); const now = () => clock, origin = "https://rotation.test";
  const vault = new CredentialVault({ test: Buffer.alloc(32, 94).toString("base64") }, "test");
  const auth = new CustomerAuth(db, { origin }, now), connections = new CustomerConnections(db, auth, vault, now);
  await auth.provisionCustomer({ name: "Rotation fixture", email: "rotation@example.test", password: "rotating credential fixture password" });
  const login = await auth.login("rotation@example.test", "rotating credential fixture password");
  const principal = await auth.requireSession(new Request(origin, { headers: { cookie: login.cookie.split(";")[0] } }));
  const oauth = { provider: "TIKTOK" as const, capability: "SOCIAL" as const, pkce: true, scopes: ["video.publish", "user.info.basic"],
    redirectUri: `${origin}/api/connections/tiktok/callback` };
  const attempt = await connections.beginOAuth(principal, oauth);
  const grant = await connections.completeAuthorization(principal, attempt.state, oauth, { providerUserId: "verified-subject",
    accessToken: "old-access", refreshToken: "old-rotating-refresh", scopes: oauth.scopes, expiresAt: new Date(clock.getTime() + 30_000), connectionMode: "MOCK" });
  await db.providerAuthorization.update({ where: { id: grant.id }, data: { refreshExpiresAt: new Date(clock.getTime() + 86400_000) } });
  const parent = await db.providerAuthorization.findUniqueOrThrow({ where: { id: grant.id } });
  const destination = await connections.registerDestination(principal, grant.id, { kind: "TIKTOK_PROFILE", externalId: "verified-subject", name: "Owned account" });
  await db.connectionDestination.update({ where: { id: destination.id }, data: { selected: true, metadata: { canWrite: "ALLOWED" } } });
  const asset = await db.socialMediaAsset.create({ data: { ownerId: principal.userId, storageKey: "private-fixture", digest: "a".repeat(64),
    bytes: 8, mime: "video/mp4", type: "VIDEO", width: 320, height: 480, durationMs: 1000, status: "AVAILABLE", verifiedAt: clock } });
  const registry = new SocialProviderRegistry();
  registry.register({ platform: "TIKTOK", kind: "TIKTOK_PROFILE", modes: ["mock"], requiredScopes: oauth.scopes,
    formats: ["SHORT_VIDEO"], renewableCredentials: true, factory: () => ({ validate: async () => {}, prepare: async () => ({}),
      publish: async () => ({ externalId: "unused" }), status: async () => ({ status: "UNKNOWN" }) }) });
  const service = new SocialPostService(db, auth, { mode: "mock", writesEnabled: true, approvedProviders: ["TIKTOK:TIKTOK_PROFILE"] }, registry, now);
  const post = await service.create(principal, { title: "Reviewed future post", body: "Reviewed fixture", mediaIds: [asset.id],
    variants: [{ destinationId: destination.id, format: "SHORT_VIDEO" }] });
  await service.approve(principal, post.id, post.revision!.id, [destination.id]);
  const queued = await service.enqueue(principal, post.id, { revisionId: post.revision!.id, destinationIds: [destination.id],
    enqueueId: "rotation-queued-key", dueAt: new Date(clock.getTime() + 3600_000).toISOString(), timeZone: "UTC" });
  const state = new SocialCredentialRenewalState(db, vault, { mode: "mock", leaseMs: 1000, now });
  const request: Omit<SocialRotatingRenewalRequest, "exchange"> = { ownerId: principal.userId, authorizationId: grant.id, provider: "TIKTOK",
    generation: parent.generation, credentialVersion: parent.credentialVersion, requiredScopes: oauth.scopes, verifyCaller: async () => {} };
  const result = (): VerifiedRotatedSocialGrant => ({ providerUserId: parent.providerUserId, accessToken: "new-access", refreshToken: "new-rotating-refresh",
    scopes: oauth.scopes, expiresAt: new Date(clock.getTime() + 3600_000), refreshExpiresAt: new Date(clock.getTime() + 90 * 86400_000) });
  return { db, auth, principal, connections, vault, now, parent, grant, oauth, destination, queued, state, request, result,
    advance: (milliseconds: number) => { clock = new Date(clock.getTime() + milliseconds); },
    close: async () => { await db.$disconnect(); await rm(directory, { recursive: true, force: true }); } };
}

test("two callers acquire one durable refresh exchange and later callers adopt the verified persisted winner", async () => {
  const q = await setup(), entered = gate(), finish = gate(); let exchanges = 0, guards = 0;
  try {
    const first = q.state.renew({ ...q.request, verifyCaller: async () => { guards++; }, exchange: async (snapshot, beforeRequest) => {
      exchanges++; assert.equal(snapshot.refreshToken, "old-rotating-refresh"); await beforeRequest(); entered.release(); await finish.promise;
      await beforeRequest(); return q.result(); } });
    await entered.promise;
    const lease = await q.db.socialCredentialRenewalLease.findUniqueOrThrow({ where: { authorizationId: q.grant.id } });
    assert.equal(lease.requestCount, 1); assert.doesNotMatch(JSON.stringify(lease), /old-rotating-refresh|new-rotating-refresh|old-access/);
    await assert.rejects(q.state.renew({ ...q.request, exchange: async () => { exchanges++; return q.result(); } }),
      (error: unknown) => error instanceof SocialProviderFailure && error.kind === "TRANSIENT" && error.definitive);
    finish.release(); await first;
    const adopted = await q.state.renew({ ...q.request, exchange: async () => { exchanges++; return q.result(); } });
    assert.equal(adopted.accessToken, "new-access"); assert.equal(exchanges, 1); assert.equal(guards, 3);
    const parent = await q.db.providerAuthorization.findUniqueOrThrow({ where: { id: q.grant.id } });
    assert.equal(parent.credentialVersion, q.parent.credentialVersion + 1);
    assert.equal(parent.refreshExpiresAt?.toISOString(), q.result().refreshExpiresAt?.toISOString());
    assert.equal(q.vault.decrypt(parent.refreshCiphertext!, credentialContext(parent.userId, parent.id, "refresh")), "new-rotating-refresh");
    assert.equal(await q.db.socialCredentialRenewalLease.count(), 0);
  } finally { finish.release(); await q.close(); }
});

for (const action of ["disconnect", "reconsent"] as const) {
  test(`${action} during rotation rejects the stale result and never overwrites the new consent`, async () => {
    const q = await setup(), entered = gate(), finish = gate();
    try {
      const work = q.state.renew({ ...q.request, exchange: async (_snapshot, beforeRequest) => { await beforeRequest(); entered.release(); await finish.promise; return q.result(); } });
      const outcome = work.then(() => undefined, (error: unknown) => error); await entered.promise;
      if (action === "disconnect") await q.connections.disconnect(q.principal, q.grant.id);
      else {
        const attempt = await q.connections.beginOAuth(q.principal, { ...q.oauth, reconnectAuthorizationId: q.grant.id });
        await q.connections.completeAuthorization(q.principal, attempt.state, q.oauth, { providerUserId: q.parent.providerUserId,
          accessToken: "new-consent-access", refreshToken: "new-consent-refresh", scopes: q.oauth.scopes,
          expiresAt: new Date(q.now().getTime() + 3600_000), connectionMode: "MOCK" });
      }
      finish.release(); assert.ok(await outcome instanceof Error);
      const parent = await q.db.providerAuthorization.findUniqueOrThrow({ where: { id: q.grant.id } });
      assert.equal(parent.status, action === "disconnect" ? "DISCONNECTED" : "CONNECTED");
      if (parent.accessCiphertext) assert.equal(q.vault.decrypt(parent.accessCiphertext, credentialContext(parent.userId, parent.id, "access")), "new-consent-access");
    } finally { finish.release(); await q.close(); }
  });
}

test("an expired started lease fences a crash and cancels unsent work without another token exchange", async () => {
  const q = await setup(), entered = gate(), finish = gate(); let exchanges = 0;
  try {
    const crashed = q.state.renew({ ...q.request, exchange: async (_snapshot, beforeRequest) => { exchanges++; await beforeRequest(); entered.release(); await finish.promise; return q.result(); } });
    const outcome = crashed.then(() => undefined, (error: unknown) => error); await entered.promise; q.advance(2000);
    await assert.rejects(q.state.renew({ ...q.request, exchange: async () => { exchanges++; return q.result(); } }), { code: "RECONNECT_REQUIRED" });
    assert.equal(exchanges, 1); assert.equal((await q.db.providerAuthorization.findUniqueOrThrow({ where: { id: q.grant.id } })).status, "RECONNECT_REQUIRED");
    assert.equal((await q.db.socialDelivery.findUniqueOrThrow({ where: { id: q.queued.deliveries[0].id } })).status, "CANCELLED");
    assert.ok((await q.db.socialCredentialRenewalLease.findUniqueOrThrow({ where: { authorizationId: q.grant.id } })).startedAt);
    finish.release(); assert.ok(await outcome instanceof Error);
  } finally { finish.release(); await q.close(); }
});

test("key-only version rotation cannot erase an expired started refresh uncertainty marker", async () => {
  const q = await setup(), entered = gate(), finish = gate();
  try {
    const pending = q.state.renew({ ...q.request, exchange: async (_snapshot, beforeRequest) => { await beforeRequest(); entered.release(); await finish.promise; return q.result(); } });
    const outcome = pending.then(() => undefined, (error: unknown) => error); await entered.promise;
    await q.db.providerAuthorization.update({ where: { id: q.grant.id }, data: { credentialVersion: { increment: 1 } } }); q.advance(2000);
    await assert.rejects(q.state.renew({ ...q.request, credentialVersion: q.parent.credentialVersion + 1, exchange: async () => q.result() }), { code: "RECONNECT_REQUIRED" });
    finish.release(); assert.ok(await outcome instanceof Error);
  } finally { finish.release(); await q.close(); }
});

for (const phase of ["first-token", "later-identity"] as const) {
  test(`${phase} definitive429 distinguishes safe retry from an accepted rotation requiring reconnect`, async () => {
    const q = await setup();
    try {
      const request = { ...q.request, exchange: async (_snapshot: unknown, beforeRequest: () => Promise<void>) => {
        await beforeRequest(); if (phase === "later-identity") await beforeRequest();
        throw new SocialRenewalExchangeError("RATE_LIMIT", true, 2000);
      } };
      if (phase === "first-token") {
        await assert.rejects(q.state.renew(request), (error: unknown) => error instanceof SocialProviderFailure && error.kind === "RATE_LIMIT" && error.definitive);
        assert.equal(await q.db.socialCredentialRenewalLease.count(), 0);
        await q.state.renew({ ...q.request, exchange: async (_snapshot, beforeRequest) => { await beforeRequest(); return q.result(); } });
      } else {
        await assert.rejects(q.state.renew(request), { code: "RECONNECT_REQUIRED" });
        assert.equal((await q.db.providerAuthorization.findUniqueOrThrow({ where: { id: q.grant.id } })).refreshCiphertext, null);
      }
    } finally { await q.close(); }
  });
}

test("an ambiguous first exchange never schedules reuse of the old rotating refresh token", async () => {
  const q = await setup();
  try { await assert.rejects(q.state.renew({ ...q.request, exchange: async (_snapshot, beforeRequest) => {
    await beforeRequest(); throw new Error("private provider token response lost"); } }), { code: "RECONNECT_REQUIRED" });
    assert.equal((await q.db.providerAuthorization.findUniqueOrThrow({ where: { id: q.grant.id } })).status, "RECONNECT_REQUIRED");
  } finally { await q.close(); }
});

test("actual refresh expiry blocks exchange and verified rotated expiry is persisted without an invented lifetime", async () => {
  const q = await setup(); let exchanges = 0;
  try {
    await q.db.providerAuthorization.update({ where: { id: q.grant.id }, data: { refreshExpiresAt: new Date(q.now().getTime() - 1) } });
    await assert.rejects(q.state.renew({ ...q.request, exchange: async () => { exchanges++; return q.result(); } }), { code: "RECONNECT_REQUIRED" });
    assert.equal(exchanges, 0);
  } finally { await q.close(); }
});

test("wrong owner/provider/mode, Ads-only grants and scope loss cannot claim or send a rotating exchange", async () => {
  const q = await setup(); let exchanges = 0;
  try {
    const exchange: SocialRotatingRenewalRequest["exchange"] = async () => { exchanges++; return q.result(); };
    await assert.rejects(q.state.renew({ ...q.request, ownerId: "foreign-owner", exchange }), { code: "STALE_CREDENTIALS" });
    await assert.rejects(new SocialCredentialRenewalState(q.db, q.vault, { mode: "live", now: q.now }).renew({ ...q.request, exchange }), { code: "STALE_CREDENTIALS" });
    await assert.rejects(q.state.renew({ ...q.request, provider: "X", exchange }), { code: "STALE_CREDENTIALS" });
    const adsOnly = await q.db.providerAuthorization.create({ data: { userId: q.principal.userId, provider: "TIKTOK",
      providerUserId: q.parent.providerUserId, capability: "ADS", connectionMode: "MOCK", scopes: q.oauth.scopes } });
    await assert.rejects(q.state.renew({ ...q.request, authorizationId: adsOnly.id, exchange }), { code: "STALE_CREDENTIALS" });
    await q.db.providerAuthorization.update({ where: { id: q.grant.id }, data: { scopes: ["user.info.basic"] } });
    await assert.rejects(q.state.renew({ ...q.request, exchange }), { code: "MISSING_PERMISSION" }); assert.equal(exchanges, 0);
  } finally { await q.close(); }
});

test("caller guard runs outside transactions and stops a revoked job before the next SDK HTTP", async () => {
  const q = await setup(); let guardCalls = 0, requests = 0;
  try {
    await assert.rejects(q.state.renew({ ...q.request, verifyCaller: async () => {
      // An independent transaction proves the hook is not invoked within the coordinator's transaction.
      await q.db.$transaction(async tx => { await tx.providerAuthorization.findUniqueOrThrow({ where: { id: q.grant.id } }); });
      if (++guardCalls === 3) throw new Error("caller job cancelled");
    }, exchange: async (_snapshot, beforeRequest) => { await beforeRequest(); requests++; await beforeRequest(); requests++; return q.result(); } }), { code: "RECONNECT_REQUIRED" });
    assert.equal(requests, 1); assert.equal(guardCalls, 3);
  } finally { await q.close(); }
});
test("an expired unstarted lease may be reclaimed, while its late original holder cannot send", async () => {
  const q = await setup(), entered = gate(), finish = gate(); let requests = 0;
  try {
    const old = q.state.renew({ ...q.request, exchange: async (_snapshot, beforeRequest) => {
      entered.release(); await finish.promise; await beforeRequest(); requests++; return q.result(); } });
    const outcome = old.then(() => undefined, (error: unknown) => error); await entered.promise; q.advance(2000);
    await q.state.renew({ ...q.request, exchange: async (_snapshot, beforeRequest) => { await beforeRequest(); requests++; return q.result(); } });
    finish.release(); assert.ok(await outcome instanceof Error); assert.equal(requests, 1);
    assert.equal((await q.db.providerAuthorization.findUniqueOrThrow({ where: { id: q.grant.id } })).status, "CONNECTED");
  } finally { finish.release(); await q.close(); }
});

test("null refresh expiry stays explicitly unknown and invalid rotated expiry cannot restore the old token", async () => {
  for (const expiry of [null, "expired"] as const) {
    const q = await setup();
    try {
      const request = { ...q.request, exchange: async (_snapshot: unknown, beforeRequest: () => Promise<void>) => {
        await beforeRequest(); return { ...q.result(), refreshExpiresAt: expiry === null ? null : new Date(q.now().getTime() - 1) }; } };
      if (expiry === null) {
        await q.state.renew(request);
        assert.equal((await q.db.providerAuthorization.findUniqueOrThrow({ where: { id: q.grant.id } })).refreshExpiresAt, null);
      } else {
        await assert.rejects(q.state.renew(request), { code: "RECONNECT_REQUIRED" });
        assert.equal((await q.db.providerAuthorization.findUniqueOrThrow({ where: { id: q.grant.id } })).refreshCiphertext, null);
      }
    } finally { await q.close(); }
  }
});

test("scope loss between accepted rotation and identity verification cannot persist or send the next request", async () => {
  const q = await setup(); let requests = 0;
  try {
    await assert.rejects(q.state.renew({ ...q.request, exchange: async (_snapshot, beforeRequest) => {
      await beforeRequest(); requests++;
      await q.db.providerAuthorization.update({ where: { id: q.grant.id }, data: { scopes: ["user.info.basic"], credentialVersion: { increment: 1 } } });
      await beforeRequest(); requests++; return q.result(); } }), { code: "RECONNECT_REQUIRED" });
    assert.equal(requests, 1);
    assert.equal((await q.db.providerAuthorization.findUniqueOrThrow({ where: { id: q.grant.id } })).status, "RECONNECT_REQUIRED");
  } finally { await q.close(); }
});

test("an adapter returning rotated credentials without a guarded exchange cannot reuse its old token", async () => {
  const q = await setup();
  try {
    await assert.rejects(q.state.renew({ ...q.request, exchange: async () => q.result() }), { code: "RECONNECT_REQUIRED" });
    const parent = await q.db.providerAuthorization.findUniqueOrThrow({ where: { id: q.grant.id } });
    assert.equal(parent.status, "RECONNECT_REQUIRED");
    assert.equal(parent.refreshCiphertext, null);
    assert.equal((await q.db.socialDelivery.findUniqueOrThrow({ where: { id: q.queued.deliveries[0].id } })).status, "CANCELLED");
  } finally { await q.close(); }
});
