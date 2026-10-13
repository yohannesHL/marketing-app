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
import { SocialDeliveryWorker } from "../../apps/web/src/server/social/deliveryWorker";
import { SocialProviderRegistry, type SocialCredentialRenewal } from "../../apps/web/src/server/social/types";
import { YouTubeError, YOUTUBE_SCOPES } from "../../apps/web/src/server/providers/youtube";
import { applyConnectionMigrations } from "../support/test-database";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((done) => { release = done; });
  return { release, promise };
}

/** Isolated real SQLite tests of the durable renewal protocol. SDK HTTP renewal is covered separately. */
async function setup(deliveryCount = 1) {
  const directory = await mkdtemp(join(tmpdir(), "social-credential-renewal-"));
  const url = `file:${join(directory, "test.sqlite")}`, sql = createClient({ url });
  await applyConnectionMigrations(sql); sql.close();
  const db = new PrismaClient({ adapter: new PrismaLibSql({ url }) });
  let clock = new Date("2026-10-13T12:00:00Z");
  const now = () => clock, origin = "https://renewal.test";
  const vault = new CredentialVault({ test: Buffer.alloc(32, 91).toString("base64") }, "test");
  const auth = new CustomerAuth(db, { origin }, now), connections = new CustomerConnections(db, auth, vault, now);
  await auth.provisionCustomer({ name: "Renewal fixture", email: "renewal@example.test", password: "independent renewal fixture password" });
  const login = await auth.login("renewal@example.test", "independent renewal fixture password");
  const principal = await auth.requireSession(new Request(origin, { headers: { cookie: login.cookie.split(";")[0] } }));
  const oauth = { provider: "GOOGLE" as const, capability: "SOCIAL" as const, pkce: true, scopes: [...YOUTUBE_SCOPES],
    redirectUri: `${origin}/api/connections/youtube/callback` };
  const attempt = await connections.beginOAuth(principal, oauth);
  const grant = await connections.completeAuthorization(principal, attempt.state, oauth, {
    providerUserId: "verified-subject", accessToken: "old-access", refreshToken: "reusable-refresh",
    scopes: [...YOUTUBE_SCOPES], expiresAt: new Date(clock.getTime() + 30_000), connectionMode: "MOCK",
  });
  const destination = await connections.registerDestination(principal, grant.id, {
    kind: "YOUTUBE_CHANNEL", externalId: "UCfixture", name: "Verified channel",
  });
  await db.connectionDestination.update({ where: { id: destination.id },
    data: { selected: true, metadata: { canWrite: "ALLOWED" }, lastCheckedAt: clock } });
  // Trusted fixture metadata exercises the worker contract; media-store tests cover actual probing.
  const asset = await db.socialMediaAsset.create({ data: { ownerId: principal.userId, storageKey: "review-fixture",
    digest: "a".repeat(64), mime: "video/mp4", type: "VIDEO", bytes: 8, width: 320, height: 480,
    durationMs: 1000, status: "AVAILABLE", verifiedAt: clock } });
  let sends = 0;
  const registry = new SocialProviderRegistry();
  registry.register({ platform: "GOOGLE", kind: "YOUTUBE_CHANNEL", modes: ["mock"], formats: ["SHORT_VIDEO"],
    requiredScopes: [...YOUTUBE_SCOPES], renewableCredentials: true,
    factory: () => ({ validate: async () => {}, prepare: async () => ({}),
      publish: async (context) => context.rpc("PUBLISH", async () => { sends++; return { externalId: `published-${context.deliveryId}` }; }),
      status: async () => ({ status: "UNKNOWN" }) }) });
  const config = { mode: "mock" as const, writesEnabled: true, approvedProviders: ["GOOGLE:YOUTUBE_CHANNEL"], maxAttempts: 3 };
  const service = new SocialPostService(db, auth, config, registry, now), due = new Date(clock.getTime() + 120_000);
  const deliveryIds: string[] = [];
  for (let index = 0; index < deliveryCount; index++) {
    const post = await service.create(principal, { title: `Renewal ${index}`, body: "Reviewed fixture", mediaIds: [asset.id],
      variants: [{ destinationId: destination.id, format: "SHORT_VIDEO" }] });
    await service.approve(principal, post.id, post.revision!.id, [destination.id]);
    const queued = await service.enqueue(principal, post.id, { revisionId: post.revision!.id, destinationIds: [destination.id],
      enqueueId: `renewal-key-${index}`, dueAt: due.toISOString(), timeZone: "UTC" });
    deliveryIds.push(queued.deliveries[0].id);
  }
  clock = due;
  return { db, now, vault, auth, principal, connections, grant, oauth, deliveryIds, sends: () => sends,
    worker: (renew: SocialCredentialRenewal) => new SocialDeliveryWorker(db, vault, registry, config,
      async ({ media }) => media.map((item) => ({ id: item.id, url: "https://renewal.test/fixture-media" })), now, renew),
    advance: (milliseconds: number) => { clock = new Date(clock.getTime() + milliseconds); },
    close: async () => { await db.$disconnect(); await rm(directory, { recursive: true, force: true }); } };
}
function renewed(request: Parameters<SocialCredentialRenewal>[0], now: Date, accessToken = "fresh-access") {
  return { providerUserId: request.providerUserId, accessToken, refreshToken: request.refreshToken,
    scopes: request.scopes, expiresAt: new Date(now.getTime() + 3600_000) };
}

test("parallel scheduled renewals of one Google grant adopt the verified winner and both publish once", async () => {
  const q = await setup(2), enteredFirst = gate(), enteredSecond = gate(), finishFirst = gate(), finishSecond = gate();
  let renewals = 0;
  try {
    const renew: SocialCredentialRenewal = async (request) => {
      const index = ++renewals;
      if (index === 1) { enteredFirst.release(); await finishFirst.promise; }
      else { enteredSecond.release(); await finishSecond.promise; }
      await request.verifyCurrent();
      return renewed(request, q.now(), `fresh-${index}`);
    };
    const first = q.worker(renew).runOnce(); await enteredFirst.promise;
    const second = q.worker(renew).runOnce(); await enteredSecond.promise;
    finishFirst.release(); const a = await first; finishSecond.release(); const b = await second;
    assert.deepEqual([a?.status, b?.status], ["SUCCEEDED", "SUCCEEDED"]); assert.equal(q.sends(), 2);
    const row = await q.db.providerAuthorization.findUniqueOrThrow({ where: { id: q.grant.id } });
    assert.equal(row.credentialVersion, q.grant.credentialVersion + 1);
    assert.equal(vaultPlain(q, row.accessCiphertext!), "fresh-1");
  } finally { finishFirst.release(); finishSecond.release(); await q.close(); }
});
function vaultPlain(q: Awaited<ReturnType<typeof setup>>, envelope: string) {
  return q.vault.decrypt(envelope, credentialContext(q.principal.userId, q.grant.id, "access"));
}

for (const status of [429, 503]) {
  test(`temporary Google renewal ${status} uses bounded retry without a publication send`, async () => {
    const q = await setup(); let calls = 0;
    try {
      const worker = q.worker(async (request) => { calls++; await request.verifyCurrent();
        throw new YouTubeError(status === 429 ? "PROVIDER_RATE_LIMITED" : "PROVIDER_REQUEST_FAILED", status, true); });
      assert.equal((await worker.runOnce())?.status, "RETRY_WAIT"); assert.equal(q.sends(), 0);
      assert.equal(await worker.runOnce(), null); q.advance(10_000);
      assert.equal((await worker.runOnce())?.status, "RETRY_WAIT"); q.advance(10_000);
      assert.equal((await worker.runOnce())?.status, "FAILED"); assert.equal(calls, 3); assert.equal(q.sends(), 0);
    } finally { await q.close(); }
  });
}

for (const action of ["disconnect", "reconsent", "scope-loss"] as const) {
  test(`a ${action} during renewal cannot adopt replacement credentials or send the stale delivery`, async () => {
    const q = await setup(), entered = gate(), finish = gate();
    try {
      const work = q.worker(async (request) => { entered.release(); await finish.promise;
        // Represents an already-completed provider response arriving after a concurrent local change.
        return renewed(request, q.now(), "stale-renewal-access"); }).runOnce();
      await entered.promise;
      if (action === "disconnect") await q.connections.disconnect(q.principal, q.grant.id);
      if (action === "reconsent") {
        const attempt = await q.connections.beginOAuth(q.principal, { ...q.oauth, reconnectAuthorizationId: q.grant.id });
        await q.connections.completeAuthorization(q.principal, attempt.state, q.oauth, {
          providerUserId: "verified-subject", accessToken: "new-consent-access", refreshToken: "new-consent-refresh",
          scopes: [...YOUTUBE_SCOPES], expiresAt: new Date(q.now().getTime() + 3600_000), connectionMode: "MOCK",
        });
      }
      if (action === "scope-loss") await q.connections.updateCredentials(q.grant.id, q.grant.credentialVersion, {
        accessToken: "limited-access", scopes: ["openid"], expiresAt: new Date(q.now().getTime() + 3600_000),
      });
      finish.release(); await work;
      const delivery = await q.db.socialDelivery.findUniqueOrThrow({ where: { id: q.deliveryIds[0] } });
      assert.equal(delivery.status, action === "scope-loss" ? "BLOCKED" : "CANCELLED"); assert.equal(q.sends(), 0);
      const parent = await q.db.providerAuthorization.findUniqueOrThrow({ where: { id: q.grant.id } });
      if (parent.accessCiphertext) assert.notEqual(vaultPlain(q, parent.accessCiphertext), "stale-renewal-access");
      assert.equal(parent.status, action === "disconnect" ? "DISCONNECTED" : "CONNECTED");
    } finally { finish.release(); await q.close(); }
  });
}
