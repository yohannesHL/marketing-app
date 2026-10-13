import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../../apps/web/src/generated/prisma/client";
import { CustomerAuth } from "../../apps/web/src/server/auth/customerAuth";
import { CustomerConnections, credentialContext } from "../../apps/web/src/server/connections/customerConnections";
import { renewTikTokPublishing } from "../../apps/web/src/server/connections/tiktokRenewal";
import { CredentialVault } from "../../apps/web/src/server/security/credentialVault";
import { SocialPostService } from "../../apps/web/src/server/social/postService";
import { SocialDeliveryWorker } from "../../apps/web/src/server/social/deliveryWorker";
import { SocialProviderRegistry, type SocialCredentialRenewal } from "../../apps/web/src/server/social/types";
import { TikTokClient, TikTokError, TIKTOK_SCOPES, type TikTokConfig } from "../../apps/web/src/server/providers/tiktok";
import { applyConnectionMigrations } from "../support/test-database";
import { startMockoon } from "../support/mockoon";

let mock: Awaited<ReturnType<typeof startMockoon>>;
before(async () => { mock = await startMockoon("tests/mockoon/tiktok.json"); });
after(async () => { await mock?.stop(); });
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((done) => { release = done; });
  return { release, promise };
}

/** Real OAuth/renewal HTTP and SQLite; the publication adapter below tests only the worker protocol.
 * Actual TikTok publication formats, uploads, and decoded media have separate provider/media tests. */
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "tiktok-renewal-runtime-"));
  const url = `file:${join(directory, "test.sqlite")}`, sql = createClient({ url });
  await applyConnectionMigrations(sql); sql.close();
  const db = new PrismaClient({ adapter: new PrismaLibSql({ url }) });
  let clock = new Date("2026-10-13T12:00:00Z");
  const now = () => clock, origin = "https://tiktok-renewal.test";
  const config: TikTokConfig = { clientKey: "tt-client", clientSecret: "fixture-tt-secret",
    redirectUri: `${origin}/api/connections/tiktok/callback`, now,
    mockoonEnabled: true, mockoonBaseUrl: mock.origin };
  const vault = new CredentialVault({ fixture: Buffer.alloc(32, 96).toString("base64") }, "fixture");
  const auth = new CustomerAuth(db, { origin }, now), connections = new CustomerConnections(db, auth, vault, now);
  await auth.provisionCustomer({ name: "TikTok renewal fixture", email: "tt-renewal@example.test", password: "independent rotating token fixture password" });
  const login = await auth.login("tt-renewal@example.test", "independent rotating token fixture password");
  const principal = await auth.requireSession(new Request(origin, { headers: { cookie: login.cookie.split(";")[0] } }));
  const oauth = { provider: "TIKTOK" as const, capability: "SOCIAL" as const, pkce: false,
    scopes: [...TIKTOK_SCOPES], redirectUri: config.redirectUri };
  const attempt = await connections.beginOAuth(principal, oauth);
  const verified = await new TikTokClient(config).exchangeCode({ code: "success" });
  const grant = await connections.completeAuthorization(principal, attempt.state, oauth, { ...verified, connectionMode: "MOCK" });
  const captured = await db.providerAuthorization.findUniqueOrThrow({ where: { id: grant.id } });
  const destination = await connections.registerDestination(principal, grant.id, {
    kind: "TIKTOK_PROFILE", externalId: verified.providerUserId, name: verified.name });
  await db.connectionDestination.update({ where: { id: destination.id }, data: { selected: true, metadata: { canWrite: "ALLOWED" }, lastCheckedAt: clock } });
  const media = await db.socialMediaAsset.create({ data: { ownerId: principal.userId, storageKey: "protocol-fixture",
    digest: "a".repeat(64), mime: "video/mp4", type: "VIDEO", bytes: 8, width: 720, height: 1280,
    durationMs: 10000, metadata: { videoCodec: "h264", fps: 30 }, status: "AVAILABLE", verifiedAt: clock } });
  let sends = 0;
  const registry = new SocialProviderRegistry();
  registry.register({ platform: "TIKTOK", kind: "TIKTOK_PROFILE", modes: ["mock"], formats: ["SHORT_VIDEO"],
    requiredScopes: [...TIKTOK_SCOPES], renewableCredentials: true,
    factory: () => ({ validate: async () => {}, prepare: async () => ({}),
      publish: async (context) => context.rpc("PUBLISH", async (call) => {
        await call.verifyCurrent(); assert.equal(call.accessToken, "tt-rotated"); sends++;
        return { externalId: `protocol-published-${context.deliveryId}` };
      }), status: async () => ({ status: "UNKNOWN" }) }) });
  const workerConfig = { mode: "mock" as const, writesEnabled: true, approvedProviders: ["TIKTOK:TIKTOK_PROFILE"], maxAttempts: 3 };
  const service = new SocialPostService(db, auth, workerConfig, registry, now);
  const renewalRequest = { ownerId: principal.userId, authorizationId: grant.id, generation: captured.generation,
    credentialVersion: grant.credentialVersion, verifyCurrent: async () => {} };
  const draft = async () => {
    const post = await service.create(principal, { title: "Reviewed fixture", body: "Protocol-only scheduled post", mediaIds: [media.id],
      variants: [{ destinationId: destination.id, format: "SHORT_VIDEO" }] });
    await service.approve(principal, post.id, post.revision!.id, [destination.id]);
    return post;
  };
  const enqueue = async (dueAt = new Date(clock.getTime() + 48 * 3600_000)) => {
    const post = await draft();
    const queued = await service.enqueue(principal, post.id, { revisionId: post.revision!.id, destinationIds: [destination.id],
      enqueueId: randomUUID(), dueAt: dueAt.toISOString(), timeZone: "UTC" });
    return { post, queued, dueAt };
  };
  const renew = (renewalConfig: TikTokConfig = config): SocialCredentialRenewal => (request) => {
    assert.equal(request.provider, "TIKTOK"); assert.equal(request.mode, "mock");
    return renewTikTokPublishing(db, vault, renewalConfig, { ownerId: request.ownerId, authorizationId: request.authorizationId,
      generation: request.authorizationGeneration, credentialVersion: request.credentialVersion, verifyCurrent: request.verifyCurrent });
  };
  return { db, vault, auth, connections, principal, config, now, grant, destination, service, renewalRequest, draft, enqueue, renew,
    sends: () => sends,
    worker: (renewalConfig = config) => new SocialDeliveryWorker(db, vault, registry, workerConfig,
      async ({ media: assets }) => assets.map((asset) => ({ id: asset.id, url: "https://tiktok-renewal.test/protocol-media" })), now, renew(renewalConfig)),
    advance: (milliseconds: number) => { clock = new Date(clock.getTime() + milliseconds); },
    close: async () => { await db.$disconnect(); await rm(directory, { force: true, recursive: true }); } };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function parent(q: Fixture) { return q.db.providerAuthorization.findUniqueOrThrow({ where: { id: q.grant.id } }); }
function plaintext(q: Fixture, value: string, kind: "access" | "refresh") {
  return q.vault.decrypt(value, credentialContext(q.principal.userId, q.grant.id, kind));
}

/** Derive an isolated HTTP response fixture; shared routes are never edited. */
async function responseFixture(kind: "token429" | "token503" | "identity429" | "scope-loss") {
  const directory = await mkdtemp(join(tmpdir(), "tt-renewal-http-"));
  const fixture = JSON.parse(await readFile("tests/mockoon/tiktok.json", "utf8"));
  const route = fixture.routes.find((r: { endpoint: string }) => r.endpoint === "v2/oauth/token/");
  const response = route.responses.find((r: { label: string }) => r.label === "tt-refresh-a");
  if (kind === "scope-loss") {
    response.body = JSON.stringify({ ...JSON.parse(response.body), scope: "user.info.basic" });
  } else if (kind === "identity429") {
    const user = fixture.routes.find((r: { endpoint: string }) => r.endpoint === "v2/user/info/");
    const failure = structuredClone(user.responses[0]); failure.uuid = randomUUID(); failure.statusCode = 429;
    failure.body = JSON.stringify({ error: { code: "rate_limit_exceeded", message: "private fixture upstream error" } });
    failure.rules = [{ target: "header", modifier: "authorization", value: "Bearer tt-rotated", invert: false, operator: "equals" }];
    user.responses.unshift(failure);
  } else {
    response.statusCode = kind === "token429" ? 429 : 503;
    response.body = JSON.stringify({ error: kind === "token429" ? "rate_limit_exceeded" : "internal_error" });
  }
  const file = join(directory, "fixture.json"); await writeFile(file, JSON.stringify(fixture));
  const server = await startMockoon(file);
  return { ...server, close: async () => { await server.stop(); await rm(directory, { force: true, recursive: true }); } };
}

test("real SDK renewal persists verified rotated credentials and actual expiry once, then adopts without another HTTP", async () => {
  const q = await setup(); let requests = 0, guards = 0;
  try {
    const config = { ...q.config, beforeRequest: async () => { requests++; } };
    const request = { ...q.renewalRequest, verifyCurrent: async () => { guards++; } };
    const grant = await renewTikTokPublishing(q.db, q.vault, config, request);
    assert.equal(grant.providerUserId, "open-id-a"); assert.deepEqual(grant.scopes, [...TIKTOK_SCOPES]);
    assert.equal(requests, 2); assert.equal(guards, 3);
    const row = await parent(q);
    assert.equal(plaintext(q, row.accessCiphertext!, "access"), "tt-rotated");
    assert.equal(plaintext(q, row.refreshCiphertext!, "refresh"), "tt-refresh-rotated");
    assert.equal(row.expiresAt?.toISOString(), "2026-10-14T12:00:00.000Z");
    assert.equal(row.refreshExpiresAt?.toISOString(), "2027-08-09T12:00:00.000Z");
    assert.equal(row.credentialVersion, q.grant.credentialVersion + 1);
    await renewTikTokPublishing(q.db, q.vault, config, request);
    assert.equal(requests, 2); assert.equal((await parent(q)).credentialVersion, row.credentialVersion);
    assert.equal(await q.db.socialCredentialRenewalLease.count(), 0);
  } finally { await q.close(); }
});

test("real token response with a different subject cannot replace the owned grant", async () => {
  const q = await setup(); let requests = 0;
  try {
    await q.db.providerAuthorization.update({ where: { id: q.grant.id }, data: {
      refreshCiphertext: q.vault.encrypt("tt-refresh-wrong", credentialContext(q.principal.userId, q.grant.id, "refresh")) } });
    await assert.rejects(renewTikTokPublishing(q.db, q.vault, { ...q.config, beforeRequest: async () => { requests++; } }, q.renewalRequest), { code: "RECONNECT_REQUIRED" });
    assert.equal(requests, 1); assert.equal((await parent(q)).refreshCiphertext, null);
  } finally { await q.close(); }
});

for (const kind of ["scope-loss", "token503", "identity429"] as const) {
  test(`real HTTP ${kind} after possible rotation requires reconnect rather than reusing the old refresh token`, async () => {
    const q = await setup(), server = await responseFixture(kind); let requests = 0;
    try {
      await assert.rejects(renewTikTokPublishing(q.db, q.vault, { ...q.config, mockoonBaseUrl: server.origin,
        beforeRequest: async () => { requests++; } }, q.renewalRequest), { code: "RECONNECT_REQUIRED" });
      assert.equal(requests, kind === "identity429" ? 2 : 1);
      const row = await parent(q); assert.equal(row.status, "RECONNECT_REQUIRED"); assert.equal(row.refreshCiphertext, null);
      assert.ok((await q.db.socialCredentialRenewalLease.findUniqueOrThrow({ where: { authorizationId: row.id } })).startedAt);
    } finally { await server.close(); await q.close(); }
  });
}

test("real first-token HTTP429 permits bounded worker retry without publication or token replacement", async () => {
  const q = await setup(), server = await responseFixture("token429"); let requests = 0;
  try {
    const { dueAt } = await q.enqueue(); q.advance(dueAt.getTime() - q.now().getTime());
    const worker = q.worker({ ...q.config, mockoonBaseUrl: server.origin, beforeRequest: async () => { requests++; } });
    assert.equal((await worker.runOnce())?.status, "RETRY_WAIT"); assert.equal(await worker.runOnce(), null);
    q.advance(10_000); assert.equal((await worker.runOnce())?.status, "RETRY_WAIT");
    q.advance(10_000); assert.equal((await worker.runOnce())?.status, "FAILED");
    assert.equal(requests, 3); assert.equal(q.sends(), 0); assert.equal(await q.db.socialCredentialRenewalLease.count(), 0);
    const row = await parent(q); assert.equal(row.status, "CONNECTED");
    assert.equal(plaintext(q, row.refreshCiphertext!, "refresh"), "tt-refresh-a");
    assert.equal(row.credentialVersion, q.grant.credentialVersion);
  } finally { await server.close(); await q.close(); }
});

test("mode mismatch and actual expired refresh token perform no SDK HTTP", async () => {
  const q = await setup(); let requests = 0;
  try {
    await q.db.providerAuthorization.update({ where: { id: q.grant.id }, data: { connectionMode: "LIVE" } });
    const config = { ...q.config, beforeRequest: async () => { requests++; } };
    await assert.rejects(renewTikTokPublishing(q.db, q.vault, config, q.renewalRequest), { code: "STALE_CREDENTIALS" });
    await q.db.providerAuthorization.update({ where: { id: q.grant.id }, data: { connectionMode: "MOCK", refreshExpiresAt: new Date(q.now().getTime() - 1) } });
    await assert.rejects(renewTikTokPublishing(q.db, q.vault, config, q.renewalRequest), { code: "RECONNECT_REQUIRED" });
    assert.equal(requests, 0);
  } finally { await q.close(); }
});

test("scheduled workers renew via real SDK after logout and access expiry, then each protocol delivery sends once", async () => {
  const q = await setup(); let requests = 0;
  try {
    const first = await q.enqueue(), second = await q.enqueue(first.dueAt);
    await q.auth.logout(q.principal); await assert.rejects(q.auth.assertSession(q.principal));
    q.advance(first.dueAt.getTime() - q.now().getTime());
    assert.ok((await parent(q)).expiresAt! < q.now());
    const worker = q.worker({ ...q.config, beforeRequest: async () => { requests++; } });
    assert.equal((await worker.runOnce())?.status, "SUCCEEDED");
    assert.equal((await worker.runOnce())?.status, "SUCCEEDED"); assert.equal(await worker.runOnce(), null);
    assert.equal(q.sends(), 2); assert.equal(requests, 2);
    const row = await parent(q); assert.equal(row.credentialVersion, q.grant.credentialVersion + 1);
    assert.equal(row.refreshExpiresAt?.getTime(), q.now().getTime() + 25920000 * 1000);
    assert.equal(plaintext(q, row.refreshCiphertext!, "refresh"), "tt-refresh-rotated");
    const ids = [first.queued.deliveries[0].id, second.queued.deliveries[0].id];
    assert.equal(await q.db.socialDelivery.count({ where: { id: { in: ids }, status: "SUCCEEDED" } }), 2);
  } finally { await q.close(); }
});

test("parallel scheduled workers share one real rotating exchange and retry the busy delivery without duplicate sends", async () => {
  const q = await setup(), entered = gate(), finish = gate(); let boundaries = 0;
  try {
    const first = await q.enqueue(), second = await q.enqueue(first.dueAt);
    await q.auth.logout(q.principal); q.advance(first.dueAt.getTime() - q.now().getTime());
    const config = { ...q.config, beforeRequest: async () => {
      if (++boundaries === 2) { entered.release(); await finish.promise; }
    } };
    const work = q.worker(config).runOnce(); await entered.promise;
    assert.equal((await q.worker(config).runOnce())?.status, "RETRY_WAIT");
    assert.equal(q.sends(), 0); assert.equal(boundaries, 2);
    finish.release(); assert.equal((await work)?.status, "SUCCEEDED");
    q.advance(10_000); assert.equal((await q.worker(config).runOnce())?.status, "SUCCEEDED");
    assert.equal(q.sends(), 2); assert.equal(boundaries, 2);
    assert.equal((await parent(q)).credentialVersion, q.grant.credentialVersion + 1);
    assert.equal(await q.db.socialDelivery.count({ where: {
      id: { in: [first.queued.deliveries[0].id, second.queued.deliveries[0].id] }, status: "SUCCEEDED" } }), 2);
  } finally { finish.release(); await q.close(); }
});

test("disconnect after the real refresh response prevents identity HTTP, persistence and scheduled publication", async () => {
  const q = await setup(), entered = gate(), finish = gate(); let boundaries = 0;
  try {
    const { queued, dueAt } = await q.enqueue(); q.advance(dueAt.getTime() - q.now().getTime());
    const work = q.worker({ ...q.config, beforeRequest: async () => {
      if (++boundaries === 2) { entered.release(); await finish.promise; }
    } }).runOnce();
    await entered.promise; await q.connections.disconnect(q.principal, q.grant.id); finish.release(); await work;
    assert.equal(boundaries, 2); assert.equal(q.sends(), 0);
    const row = await parent(q); assert.equal(row.status, "DISCONNECTED"); assert.equal(row.refreshCiphertext, null);
    assert.equal((await q.db.socialDelivery.findUniqueOrThrow({ where: { id: queued.deliveries[0].id } })).status, "CANCELLED");
    assert.equal(await q.db.connectionAuditEvent.count({ where: { authorizationId: row.id, action: "SOCIAL_ROTATING_CREDENTIALS_RENEWED" } }), 0);
  } finally { finish.release(); await q.close(); }
});

for (const operation of ["enqueue", "reschedule"] as const) {
  test(`${operation} refuses a due time beyond the provider's actual refresh lifetime and renewal window`, async () => {
    const q = await setup();
    try {
      const expiry = (await parent(q)).refreshExpiresAt!;
      assert.equal(expiry.toISOString(), "2027-10-13T12:00:00.000Z");
      if (operation === "enqueue") {
        const post = await q.draft();
        for (const offset of [1, -30_000]) {
          await assert.rejects(q.service.enqueue(q.principal, post.id, {
            revisionId: post.revision!.id, destinationIds: [q.destination.id], enqueueId: randomUUID(),
            dueAt: new Date(expiry.getTime() + offset).toISOString(), timeZone: "UTC",
          }), { code: "RECONNECT_REQUIRED" });
        }
        assert.equal(await q.db.socialDelivery.count(), 0);
        assert.equal(await q.db.socialEnqueue.count(), 0);
      } else {
        const { post, queued, dueAt } = await q.enqueue();
        for (const offset of [1, -30_000]) {
          await assert.rejects(q.service.reschedule(q.principal, post.id, [queued.deliveries[0].id],
            new Date(expiry.getTime() + offset).toISOString(), "UTC"), { code: "RECONNECT_REQUIRED" });
        }
        const delivery = await q.db.socialDelivery.findUniqueOrThrow({ where: { id: queued.deliveries[0].id } });
        assert.equal(delivery.dueAt.getTime(), dueAt.getTime()); assert.equal(delivery.status, "QUEUED");
      }
      assert.equal(q.sends(), 0);
    } finally { await q.close(); }
  });
}


test("a typed local guard429 after actual token rotation cannot masquerade as a rejected token exchange", async () => {
  const q = await setup(); let boundaries = 0;
  try {
    q.advance(48 * 3600_000);
    const config = { ...q.config, beforeRequest: async () => {
      if (++boundaries === 2) throw new TikTokError("PROVIDER_RATE_LIMITED", 429);
    } };
    await assert.rejects(renewTikTokPublishing(q.db, q.vault, config, q.renewalRequest), { code: "RECONNECT_REQUIRED" });
    assert.equal(boundaries, 2); const row = await parent(q);
    assert.equal(row.status, "RECONNECT_REQUIRED"); assert.equal(row.accessCiphertext, null); assert.equal(row.refreshCiphertext, null);
    const lease = await q.db.socialCredentialRenewalLease.findUniqueOrThrow({ where: { authorizationId: q.grant.id } });
    assert.equal(lease.requestCount, 1); assert.ok(lease.startedAt);
    await assert.rejects(renewTikTokPublishing(q.db, q.vault, config, q.renewalRequest), { code: "STALE_CREDENTIALS" });
    assert.equal(boundaries, 2); assert.equal(q.sends(), 0);
  } finally { await q.close(); }
});
