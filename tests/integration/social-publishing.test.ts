import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../../apps/web/src/generated/prisma/client";
import { createHmac } from "node:crypto";
import { MetaLifecycleStore } from "../../apps/web/src/server/connections/metaLifecycleStore";
import { verifyMetaSignedRequest } from "../../apps/web/src/server/providers/metaSignedRequests";
import { CustomerAuth, digest, type CustomerPrincipal } from "../../apps/web/src/server/auth/customerAuth";
import { CustomerConnections } from "../../apps/web/src/server/connections/customerConnections";
import { CredentialVault } from "../../apps/web/src/server/security/credentialVault";
import { SocialPostService } from "../../apps/web/src/server/social/postService";
import { createSocialPostsApi } from "../../apps/web/src/server/social/postsApi";
import { rotateSocialProgressKeys } from "../../apps/web/src/server/social/rotateProgressKeys";
import { SocialDeliveryWorker } from "../../apps/web/src/server/social/deliveryWorker";
import { SocialProviderRegistry, SocialProviderFailure, type SocialProvider, type SocialProviderContext, type SocialProgress,
  type SocialDraftInput, type SocialWorkerConfig } from "../../apps/web/src/server/social/types";
import { applyConnectionMigrations } from "../support/test-database";

let dir: string, db: PrismaClient, auth: CustomerAuth, connections: CustomerConnections, vault: CredentialVault;
let clock = new Date("2026-10-13T12:00:00Z");
const origin = "https://launchpad.test";
const configuration: SocialWorkerConfig = { mode: "mock", writesEnabled: true, approvedProviders: ["META:FACEBOOK_PAGE"], leaseMs: 1000, maxAttempts: 3 };
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "social-publishing-")); const url = `file:${join(dir, "test.db")}`;
  const client = createClient({ url }); await applyConnectionMigrations(client); client.close();
  db = new PrismaClient({ adapter: new PrismaLibSql({ url }) });
  vault = new CredentialVault({ test: Buffer.alloc(32, 31).toString("base64") }, "test");
  auth = new CustomerAuth(db, { origin }, () => clock); connections = new CustomerConnections(db, auth, vault, () => clock);
});
beforeEach(async () => { clock = new Date("2026-10-13T12:00:00Z"); await db.socialPost.deleteMany(); });
async function customer(name: string) {
  const email = `${name}@example.test`, password = "social publishing integration password";
  await auth.provisionCustomer({ name, email, password }); const login = await auth.login(email, password), cookie = login.cookie.split(";")[0];
  const principal = await auth.requireSession(new Request(origin, { headers: { cookie } }));
  const request = (path: string, value?: unknown, method = "POST") => new Request(`${origin}${path}`, { method,
    headers: { cookie, Origin: origin, "Content-Type": "application/json" }, ...(method === "GET" ? {} : { body: JSON.stringify(value ?? {}) }) });
  return { principal, cookie, request };
}
async function destination(principal: CustomerPrincipal, label: string, capability: "SOCIAL" | "ADS" = "SOCIAL") {
  const oauth = { provider: "META" as const, capability, redirectUri: `${origin}/api/connections/meta/callback`, scopes: ["pages_manage_posts"], pkce: false };
  const start = await connections.beginOAuth(principal, oauth);
  const grant = await connections.completeAuthorization(principal, start.state, oauth, { providerUserId: label, accessToken: `secret-${label}`,
    scopes: oauth.scopes, ...(/^\d+$/.test(label) ? { externalGrantId: label } : {}), connectionMode: "MOCK", expiresAt: new Date(clock.getTime() + 30 * 86400_000) });
  const dest = await connections.registerDestination(principal, grant.id, { externalId: label, kind: capability === "SOCIAL" ? "FACEBOOK_PAGE" : "AD_ACCOUNT", name: label });
  await db.connectionDestination.update({ where: { id: dest.id }, data: { selected: true, metadata: { canWrite: "ALLOWED" }, lastCheckedAt: clock } });
  return { grant, dest };
}
const content = (destinationId?: string): SocialDraftInput => ({ title: "Reviewed launch", body: "Customer-approved post", mediaIds: [],
  variants: destinationId ? [{ destinationId, format: "TEXT", providerOptions: { shareToFeed: true } }] : [] });
// Domain-only fake adapters test the durable protocol; they do not validate any live platform contract.
function registry(overrides: Partial<SocialProvider> = {}) {
  let published = 0;
  const records: string[] = [];
  const providers = new SocialProviderRegistry();
  providers.register({ platform: "META", kind: "FACEBOOK_PAGE", modes: ["mock"], requiredScopes: ["pages_manage_posts"], formats: ["TEXT", "IMAGE", "SHORT_VIDEO"],
    factory: () => ({
      validate: async (context) => { await context.rpc("PREPARE", async (call) => { records.push(`validate:${call.destination.externalId}:${call.accessToken}`); }); },
      prepare: async (context, progress) => context.rpc("UPLOAD", async () => ({ ...progress, uploadId: `upload-${context.deliveryId}` })),
      publish: async (context) => context.rpc("PUBLISH", async (call) => { published++; records.push(`publish:${call.destination.externalId}:${call.accessToken}`); return { externalId: `post-${call.destination.externalId}`, publishUrl: `https://www.facebook.com/posts/${call.destination.externalId}` }; }),
      status: async (context) => context.rpc("PROCESS", async () => ({ status: "UNKNOWN" as const })), ...overrides,
    }) });
  return { providers, records, count: () => published };
}
const service = (providers = new SocialProviderRegistry(), config = configuration) => new SocialPostService(db, auth, config, providers, () => clock);
const worker = (providers: SocialProviderRegistry, config = configuration) => new SocialDeliveryWorker(db, vault, providers, config,
  async ({ media }) => media.map((m) => ({ id: m.id, url: `https://media.launchpad.test/signed/${m.id}?signature=private-url-secret` })), () => clock);
async function queued(name: string, options: Partial<SocialProvider> = {}, count = 1) {
  const owner = await customer(name), r = registry(options), s = service(r.providers), destinations = [];
  for (let i = 0; i < count; i++) destinations.push(await destination(owner.principal, `${name}-${i}`));
  const input = content(); input.variants = destinations.map((d) => content(d.dest.id).variants[0]);
  const post = await s.create(owner.principal, input), ids = destinations.map((d) => d.dest.id);
  await s.approve(owner.principal, post.id, post.revision!.id, ids);
  const result = await s.enqueue(owner.principal, post.id, { revisionId: post.revision!.id, destinationIds: ids,
    enqueueId: `${name}-enqueue`, dueAt: clock.toISOString(), timeZone: "Europe/London" });
  return { owner, r, s, destinations, input, post: result };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }

test("customer drafts, explicit revision review and delivery records remain separate from paid campaigns", async () => {
  const owner = await customer("social-first"), d = await destination(owner.principal, "social-first-page"), r = registry(), s = service(r.providers);
  const empty = await s.create(owner.principal, content()); assert.equal(empty.category, "SOCIAL_PUBLISHING"); assert.deepEqual(empty.revision!.variants, []);
  const post = await s.create(owner.principal, content(d.dest.id));
  const input = { revisionId: post.revision!.id, destinationIds: [d.dest.id], enqueueId: "social-first-enqueue", dueAt: clock.toISOString(), timeZone: "Europe/London" };
  await assert.rejects(s.enqueue(owner.principal, post.id, input), { code: "REVIEW_REQUIRED" });
  await s.approve(owner.principal, post.id, input.revisionId, input.destinationIds);
  const queued = await s.enqueue(owner.principal, post.id, input);
  assert.equal(queued.status, "SCHEDULED"); assert.equal(queued.deliveries[0].status, "QUEUED");
  assert.equal(queued.deliveries[0].timeZone, "Europe/London"); assert.equal(queued.deliveries[0].dueAt.toISOString(), clock.toISOString());
  assert.doesNotMatch(JSON.stringify(queued), /Ciphertext|secret-social-first|storageKey|encryptedState/);
  const paid = await db.campaign.create({ data: { name: "Old paid campaign", objective: "CLICKS", status: "PAUSED", budget: {}, targeting: {} } });
  assert.equal(paid.category, "PAID_ADVERTISING");
  await assert.rejects(db.campaign.update({ where: { id: paid.id }, data: { category: "SOCIAL_PUBLISHING" } }));
  await assert.rejects(db.socialPost.update({ where: { id: post.id }, data: { category: "PAID_ADVERTISING" } }));
});


test("durable scheduled delivery works after browser logout and publishes each destination once", async () => {
  const q = await queued("social-logout", {}, 2);
  await auth.logout(q.owner.principal);
  const first = await worker(q.r.providers).runOnce(), second = await worker(q.r.providers).runOnce();
  assert.equal(first?.status, "SUCCEEDED"); assert.equal(second?.status, "SUCCEEDED"); assert.equal(q.r.count(), 2);
  assert.equal(await worker(q.r.providers).runOnce(), null);
  const login = await auth.login("social-logout@example.test", "social publishing integration password");
  const principal = await auth.requireSession(new Request(origin, { headers: { cookie: login.cookie.split(";")[0] } }));
  const post = await q.s.get(principal, q.post.id);
  assert.equal(post.status, "COMPLETED"); assert.ok(post.deliveries.every((d) => d.externalId && d.publishUrl && d.status === "SUCCEEDED"));
  assert.doesNotMatch(JSON.stringify(post), /secret-social-logout|uploadId|encryptedState|signature=/);
});

test("duplicate enqueue is idempotent and rejects a changed request rather than duplicating deliveries", async () => {
  const q = await queued("social-duplicate");
  const request = { revisionId: q.post.revision!.id, destinationIds: [q.destinations[0].dest.id], enqueueId: "social-duplicate-enqueue", dueAt: clock.toISOString(), timeZone: "Europe/London" };
  const [a, b] = await Promise.all([q.s.enqueue(q.owner.principal, q.post.id, request), q.s.enqueue(q.owner.principal, q.post.id, request)]);
  assert.equal(a.deliveries[0].id, b.deliveries[0].id); assert.equal(a.deliveries.length, 1);
  await assert.rejects(q.s.enqueue(q.owner.principal, q.post.id, { ...request, dueAt: new Date(clock.getTime() + 10000).toISOString() }), { code: "IDEMPOTENCY_CONFLICT" });
});

test("two workers claim a due delivery once and do not share account credentials", async () => {
  const q = await queued("social-concurrent", {}, 2);
  const results = await Promise.all([worker(q.r.providers).runOnce(), worker(q.r.providers).runOnce(), worker(q.r.providers).runOnce()]);
  assert.equal(results.filter((r) => r?.status === "SUCCEEDED").length, 2); assert.equal(q.r.count(), 2);
  const publishes = q.r.records.filter((r) => r.startsWith("publish:"));
  assert.deepEqual(publishes.sort(), ["publish:social-concurrent-0:secret-social-concurrent-0", "publish:social-concurrent-1:secret-social-concurrent-1"]);
});

test("customer API enforces session, Origin, tenant IDs, capability and untrusted verification claims", async () => {
  const owner = await customer("social-security"), other = await customer("social-security-other"), d = await destination(owner.principal, "social-security-page"), foreign = await destination(other.principal, "social-foreign-page"), ad = await destination(owner.principal, "social-ad", "ADS");
  const s = service(), api = createSocialPostsApi(auth, s), post = await s.create(owner.principal, content());
  assert.equal((await api(new Request(`${origin}/api/social/posts`))).status, 401);
  assert.equal((await api(new Request(`${origin}/api/social/posts`, { method: "POST", headers: { cookie: owner.cookie, Origin: "https://evil.test" } }))).status, 403);
  assert.equal((await api(other.request(`/api/social/posts/${post.id}`, undefined, "GET"))).status, 404);
  assert.equal((await api(owner.request("/api/social/posts", { ...content(), ownerId: other.principal.userId }))).status, 400);
  assert.equal((await api(owner.request("/api/social/posts", { ...content(), durationMs: 10000 }))).status, 400);
  await assert.rejects(s.create(owner.principal, content(foreign.dest.id)), { code: "NOT_FOUND" });
  await assert.rejects(s.create(owner.principal, content(ad.dest.id)), { code: "INVALID_DESTINATION" });
  for (const providerOptions of [{ accessToken: "secret" }, { uploadUrl: "https://evil.test" }, { madeForKids: "yes" }, { privacyStatus: "automatic" }, { maxApiCostMicros: -1 }])
    await assert.rejects(s.create(owner.principal, { ...content(d.dest.id), variants: [{ ...content(d.dest.id).variants[0], providerOptions }] }), { code: "INVALID_PROVIDER_OPTIONS" });
});

test("provider registration and mode are required; disabled publication never claims simulated success", async () => {
  const owner = await customer("social-disabled"), d = await destination(owner.principal, "social-disabled-page"), s = service(new SocialProviderRegistry(), { ...configuration, writesEnabled: false, approvedProviders: [] });
  const post = await s.create(owner.principal, content(d.dest.id)); await s.approve(owner.principal, post.id, post.revision!.id, [d.dest.id]);
  assert.equal(post.publishingEnabled, false);
  assert.equal((await service(new SocialProviderRegistry(), configuration).list(owner.principal)).publishingEnabled, false);
  await assert.rejects(s.enqueue(owner.principal, post.id, { revisionId: post.revision!.id, destinationIds: [d.dest.id], enqueueId: "disabled-enqueue", dueAt: clock.toISOString(), timeZone: "UTC" }), { code: "PROVIDER_DISABLED" });
  await assert.rejects(service(new SocialProviderRegistry(), { ...configuration, mode: "live" }).create(owner.principal, content(d.dest.id)), { code: "CONNECTION_MODE_MISMATCH" });
  const q = await queued("social-registry-removed");
  assert.equal((await worker(new SocialProviderRegistry()).runOnce())?.status, "BLOCKED"); assert.equal(q.r.count(), 0);
  const blocked = await q.s.get(q.owner.principal, q.post.id); assert.equal(blocked.deliveries[0].errorCode, "PROVIDER_DISABLED");
});

test("editing reviewed disclosures creates an immutable revision and supersedes queued publication", async () => {
  const q = await queued("social-edit"); const original = q.post.revision!.id;
  const edited = await q.s.edit(q.owner.principal, q.post.id, original, { ...q.input, variants: q.input.variants.map((v) => ({ ...v, providerOptions: { shareToFeed: false } })) });
  assert.notEqual(edited.revision!.id, original); assert.equal(edited.revision!.reviewedAt, null); assert.equal(edited.status, "DRAFT");
  assert.equal(edited.deliveries[0].status, "SUPERSEDED"); assert.deepEqual(edited.revision!.variants[0].providerOptions, { shareToFeed: false });
  assert.equal(await worker(q.r.providers).runOnce(), null); assert.equal(q.r.count(), 0);
  await assert.rejects(q.s.approve(q.owner.principal, q.post.id, original, [q.destinations[0].dest.id]), { code: "STALE_REVISION" });
  await assert.rejects(db.socialPostVariant.update({ where: { id: q.post.revision!.variants[0].id }, data: { providerOptions: { shareToFeed: false } } }));
});


test("restart mid-upload resumes encrypted progress and cannot publish through an expired lease", async () => {
  const paused = deferred(), release = deferred(); let initialized = 0;
  const q = await queued("social-upload-restart", { prepare: async (context, progress) => {
    if (!progress.uploadId) {
      initialized++; progress = await context.rpc("UPLOAD", async () => ({ uploadId: "resumable-upload", sessionUrl: "https://upload.example.test/?token=private-upload-token" }));
      await context.checkpoint(progress); paused.resolve(); await release.promise;
    } else await context.rpc("UPLOAD", async () => assert.equal(progress.uploadId, "resumable-upload"));
    return progress;
  } });
  const pending = worker(q.r.providers).runOnce(); await paused.promise;
  const saved = await db.socialDeliveryProgress.findUniqueOrThrow({ where: { deliveryId: q.post.deliveries[0].id } });
  assert.doesNotMatch(saved.encryptedState, /private-upload-token|resumable-upload|https:/);
  clock = new Date(clock.getTime() + 2000);
  assert.equal((await worker(q.r.providers).runOnce())?.status, "SUCCEEDED");
  release.resolve(); assert.equal((await pending)?.status, "LEASE_LOST");
  assert.equal(initialized, 1); assert.equal(q.r.count(), 1);
  const current = await q.s.get(q.owner.principal, q.post.id);
  assert.equal(current.deliveries[0].attempts, 2); assert.equal(current.deliveries[0].status, "SUCCEEDED");
});

test("ambiguous publication remains uncertain until status reconciles without a duplicate publish", async () => {
  let calls = 0;
  const q = await queued("social-ambiguous", { publish: async (context) => context.rpc("PUBLISH", async () => { calls++; throw new Error("private publication response token=private-token"); }),
    status: async (context) => context.rpc("PROCESS", async () => ({ status: "PUBLISHED", result: { externalId: "known-post", publishUrl: "https://www.facebook.com/posts/known-post" } })) });
  assert.equal((await worker(q.r.providers).runOnce())?.status, "UNCERTAIN"); assert.equal(await worker(q.r.providers).runOnce(), null);
  const uncertain = await q.s.get(q.owner.principal, q.post.id);
  assert.equal(uncertain.deliveries[0].phase, "PUBLISH"); assert.equal(uncertain.deliveries[0].errorCode, "PUBLISH_OUTCOME_UNKNOWN");
  assert.doesNotMatch(JSON.stringify(uncertain), /private publication|private-token/);
  await assert.rejects(q.s.retry(q.owner.principal, q.post.id, [uncertain.deliveries[0].id]), { code: "RECONCILIATION_REQUIRED" });
  assert.equal((await worker(q.r.providers).reconcileOnce(uncertain.deliveries[0].id))?.status, "SUCCEEDED");
  assert.equal(calls, 1); assert.equal((await q.s.get(q.owner.principal, q.post.id)).deliveries[0].externalId, "known-post");
});

test("expired publish lease survives worker restart as uncertain and late original completion cannot overwrite reconciliation", async () => {
  const paused = deferred(), release = deferred(); let calls = 0;
  const q = await queued("social-publish-restart", { publish: async (context) => context.rpc("PUBLISH", async () => { calls++; paused.resolve(); await release.promise; return { externalId: "remote-published" }; }),
    status: async (context) => context.rpc("PROCESS", async () => ({ status: "PUBLISHED", result: { externalId: "remote-published" } })) });
  const pending = worker(q.r.providers).runOnce(); await paused.promise; clock = new Date(clock.getTime() + 2000);
  assert.equal(await worker(q.r.providers).runOnce(), null);
  assert.equal((await q.s.get(q.owner.principal, q.post.id)).deliveries[0].status, "UNCERTAIN");
  assert.equal((await worker(q.r.providers).reconcileOnce(q.post.deliveries[0].id))?.status, "SUCCEEDED");
  release.resolve(); assert.equal((await pending)?.status, "LEASE_LOST"); assert.equal(calls, 1);
  assert.equal((await q.s.get(q.owner.principal, q.post.id)).deliveries[0].externalId, "remote-published");
});

test("status rate limiting cannot make an uncertain publish eligible for resubmission", async () => {
  let calls = 0;
  const q = await queued("social-status-rate", { publish: async (context) => context.rpc("PUBLISH", async () => { calls++; throw new Error("unknown publication outcome"); }),
    status: async (context) => context.rpc("PROCESS", async () => { throw new SocialProviderFailure("RATE_LIMIT", true, 3600000); }) });
  await worker(q.r.providers).runOnce();
  assert.equal((await worker(q.r.providers).reconcileOnce(q.post.deliveries[0].id))?.status, "UNCERTAIN");
  assert.equal(await worker(q.r.providers).runOnce(), null);
  assert.equal(await worker(q.r.providers).reconcileOnce(q.post.deliveries[0].id), null);
  assert.equal(calls, 1); assert.equal((await q.s.get(q.owner.principal, q.post.id)).deliveries[0].status, "UNCERTAIN");
});

test("partial retries never repost successful destinations and safe rate-limit retries are bounded", async () => {
  const counts = new Map<string, number>();
  const q = await queued("social-partial", { publish: async (context) => context.rpc("PUBLISH", async (call) => {
    const count = (counts.get(call.destination.externalId) ?? 0) + 1; counts.set(call.destination.externalId, count);
    if (call.destination.externalId.endsWith("-1") && count === 1) throw new SocialProviderFailure("RATE_LIMIT", true, 1000);
    return { externalId: `partial-${call.destination.externalId}` };
  }) }, 2);
  const results = await Promise.all([worker(q.r.providers).runOnce(), worker(q.r.providers).runOnce()]);
  assert.ok(results.some((r) => r?.status === "SUCCEEDED")); assert.ok(results.some((r) => r?.status === "RETRY_WAIT"));
  const partial = await q.s.get(q.owner.principal, q.post.id), done = partial.deliveries.find((d) => d.status === "SUCCEEDED")!, failed = partial.deliveries.find((d) => d.status === "RETRY_WAIT")!;
  await assert.rejects(q.s.retry(q.owner.principal, q.post.id, [done.id]), { code: "RECONCILIATION_REQUIRED" });
  clock = new Date(clock.getTime() + 1001); assert.equal((await worker(q.r.providers).runOnce())?.status, "SUCCEEDED");
  assert.deepEqual([...counts.values()].sort(), [1, 2]); assert.equal((await q.s.get(q.owner.principal, q.post.id)).status, "COMPLETED");
  const blocked = await queued("social-bounded", { validate: async () => { throw new SocialProviderFailure("RATE_LIMIT", true, Number.MAX_SAFE_INTEGER); } });
  for (let i = 0; i < 3; i++) { const result = await worker(blocked.r.providers).runOnce(); assert.equal(result?.status, i === 2 ? "FAILED" : "RETRY_WAIT"); clock = new Date(clock.getTime() + 3600001); }
  assert.equal(await worker(blocked.r.providers).runOnce(), null); assert.equal(blocked.r.count(), 0);
});

for (const change of ["cancel", "edit", "disconnect", "scope"] as const) test(`each external-call boundary fences ${change} before publication`, async () => {
  const paused = deferred(), release = deferred();
  const q = await queued(`social-call-${change}`, { prepare: async (context) => { await context.rpc("UPLOAD", async () => ({})); paused.resolve(); await release.promise; await context.rpc("PROCESS", async () => ({})); return {}; } });
  const pending = worker(q.r.providers).runOnce(); await paused.promise;
  if (change === "cancel") await q.s.cancel(q.owner.principal, q.post.id, [q.post.deliveries[0].id]);
  if (change === "edit") await q.s.edit(q.owner.principal, q.post.id, q.post.revision!.id, { ...q.input, body: "Edited content" });
  if (change === "disconnect") await connections.disconnect(q.owner.principal, q.destinations[0].grant.id);
  if (change === "scope") await db.providerAuthorization.update({ where: { id: q.destinations[0].grant.id }, data: { scopes: [] } });
  release.resolve(); const result = await pending;
  assert.ok(["LEASE_LOST", "BLOCKED"].includes(result?.status ?? "")); assert.equal(q.r.count(), 0);
  const current = await q.s.get(q.owner.principal, q.post.id);
  assert.notEqual(current.deliveries[0].status, "SUCCEEDED");
  if (change === "disconnect") {
    const attempts = await db.socialDeliveryAttempt.findMany({ where: { deliveryId: current.deliveries[0].id } });
    assert.ok(attempts.length > 0); assert.ok(attempts.every((attempt) => attempt.status === "CANCELLED" && attempt.endedAt));
  }
});

test("cancellation during a sent publish exposes uncertainty and records a known late publication honestly", async () => {
  const paused = deferred(), release = deferred(); let published = 0;
  const q = await queued("social-cancel-publish", { publish: async (context) => context.rpc("PUBLISH", async () => { published++; paused.resolve(); await release.promise; return { externalId: "published-before-cancel" }; }) });
  const pending = worker(q.r.providers).runOnce(); await paused.promise;
  const cancelled = await q.s.cancel(q.owner.principal, q.post.id, [q.post.deliveries[0].id]);
  assert.equal(cancelled.deliveries[0].status, "UNCERTAIN"); assert.equal(cancelled.deliveries[0].cancellationRequested, true);
  release.resolve(); assert.equal((await pending)?.status, "SUCCEEDED"); assert.equal(published, 1);
  const current = await q.s.get(q.owner.principal, q.post.id);
  assert.equal(current.deliveries[0].externalId, "published-before-cancel"); assert.equal(current.deliveries[0].errorCode, "PUBLISHED_AFTER_CANCELLATION");
});

async function media(principal: CustomerPrincipal, name: string, expiry = new Date(clock.getTime() + 120000)) {
  return db.socialMediaAsset.create({ data: { ownerId: principal.userId, storageKey: `trusted-storage-${name}`, digest: "a".repeat(64), bytes: 400,
    mime: "image/jpeg", type: "IMAGE", width: 1200, height: 900, status: "AVAILABLE", verifiedAt: clock, expiresAt: expiry } });
}
test("owned verified media expires safely and cross-customer assets or browser duration claims cannot publish", async () => {
  const owner = await customer("social-media"), other = await customer("social-media-other"), d = await destination(owner.principal, "social-media-page"), r = registry(), s = service(r.providers);
  const foreign = await media(other.principal, "foreign");
  const draft = { ...content(d.dest.id), mediaIds: [foreign.id], variants: [{ destinationId: d.dest.id, format: "IMAGE" as const }] };
  await assert.rejects(s.create(owner.principal, draft), { code: "MEDIA_UNAVAILABLE" });
  const asset = await media(owner.principal, "own"), input = { ...draft, mediaIds: [asset.id] }, post = await s.create(owner.principal, input);
  await s.approve(owner.principal, post.id, post.revision!.id, [d.dest.id]);
  await assert.rejects(s.enqueue(owner.principal, post.id, { revisionId: post.revision!.id, destinationIds: [d.dest.id], enqueueId: "media-too-late", dueAt: new Date(clock.getTime() + 180000).toISOString(), timeZone: "UTC" }), { code: "MEDIA_UNAVAILABLE" });
  await s.enqueue(owner.principal, post.id, { revisionId: post.revision!.id, destinationIds: [d.dest.id], enqueueId: "media-due-now", dueAt: clock.toISOString(), timeZone: "UTC" });
  clock = new Date(clock.getTime() + 180000);
  assert.equal((await worker(r.providers).runOnce())?.status, "BLOCKED"); assert.equal(r.count(), 0); assert.deepEqual(r.records, []);
});

test("UTC instants retain IANA zones across repeated DST local times and rescheduling fences active work", async () => {
  clock = new Date("2026-10-25T00:00:00Z");
  const q = await queued("social-dst");
  const first = await q.s.reschedule(q.owner.principal, q.post.id, [q.post.deliveries[0].id], "2026-10-25T01:30:00+01:00", "Europe/London");
  assert.equal(first.deliveries[0].dueAt.toISOString(), "2026-10-25T00:30:00.000Z");
  const second = await q.s.reschedule(q.owner.principal, q.post.id, [q.post.deliveries[0].id], "2026-10-25T01:30:00Z", "Europe/London");
  assert.equal(second.deliveries[0].dueAt.toISOString(), "2026-10-25T01:30:00.000Z");
  await assert.rejects(q.s.reschedule(q.owner.principal, q.post.id, [q.post.deliveries[0].id], "2026-10-25T01:30:00", "Europe/London"), { code: "INVALID_SCHEDULE" });
  await assert.rejects(q.s.reschedule(q.owner.principal, q.post.id, [q.post.deliveries[0].id], clock.toISOString(), "Europe/Fiction"), { code: "INVALID_SCHEDULE" });
  assert.equal(await worker(q.r.providers).runOnce(), null);
});


test("publish ambiguity stays monotonic across processing polls and restart never repeats the send", async () => {
  const paused = deferred(), release = deferred(); let submissions = 0;
  const q = await queued("social-publish-processing", { publish: async (context) => {
    const result = await context.rpc("PUBLISH", async () => { submissions++; return { externalId: "processing-post" }; });
    await context.checkpoint({ externalId: result.externalId });
    await context.rpc("PROCESS", async () => { paused.resolve(); await release.promise; });
    return result;
  }, status: async (context, progress) => context.rpc("PROCESS", async () => ({ status: "PUBLISHED", result: { externalId: progress.externalId as string } })) });
  const pending = worker(q.r.providers).runOnce(); await paused.promise;
  const processing = await q.s.get(q.owner.principal, q.post.id); assert.equal(processing.deliveries[0].phase, "PUBLISH");
  clock = new Date(clock.getTime() + 2000); assert.equal(await worker(q.r.providers).runOnce(), null);
  assert.equal((await worker(q.r.providers).reconcileOnce(q.post.deliveries[0].id))?.status, "SUCCEEDED");
  release.resolve(); assert.equal((await pending)?.status, "LEASE_LOST"); assert.equal(submissions, 1);
});

test("authoritative not-published reconciliation cannot requeue cancelled or edited content", async () => {
  const q = await queued("social-not-published", { publish: async (context) => context.rpc("PUBLISH", async () => { throw new Error("ambiguous send"); }),
    status: async (context) => context.rpc("PROCESS", async () => ({ status: "NOT_PUBLISHED" })) });
  await worker(q.r.providers).runOnce();
  await q.s.cancel(q.owner.principal, q.post.id, [q.post.deliveries[0].id]);
  assert.equal((await worker(q.r.providers).reconcileOnce(q.post.deliveries[0].id))?.status, "CANCELLED");
  assert.equal(await worker(q.r.providers).runOnce(), null);
});

test("rescheduling rejects leased work and explicit cancellation preserves completed publication identities", async () => {
  const paused = deferred(), release = deferred();
  const q = await queued("social-reschedule-active", { prepare: async (context) => { await context.rpc("UPLOAD", async () => ({})); paused.resolve(); await release.promise; return {}; } });
  const pending = worker(q.r.providers).runOnce(); await paused.promise;
  await assert.rejects(q.s.reschedule(q.owner.principal, q.post.id, [q.post.deliveries[0].id], new Date(clock.getTime() + 10000).toISOString(), "UTC"), { code: "DELIVERY_IN_PROGRESS" });
  release.resolve(); await pending;
  const completed = await q.s.cancel(q.owner.principal, q.post.id, [q.post.deliveries[0].id]);
  assert.equal(completed.status, "COMPLETED"); assert.equal(completed.deliveries[0].status, "SUCCEEDED"); assert.equal(completed.deliveries[0].externalId, "post-social-reschedule-active-0");
});


test("key rotation preserves encrypted upload progress and a concurrent checkpoint wins the version CAS", async () => {
  const q = await queued("social-rotate", { prepare: async () => ({ uploadId: "resume-original", sessionUrl: "https://upload.example.test?token=private-session" }),
    publish: async (context) => context.rpc("PUBLISH", async () => { throw new Error("ambiguous publication"); }),
    status: async (context, progress) => context.rpc("PROCESS", async () => { assert.equal(progress.uploadId, "resume-newer"); return { status: "PUBLISHED", result: { externalId: "rotated-post" } }; }) });
  await worker(q.r.providers).runOnce();
  const keys = { test: Buffer.alloc(32, 31).toString("base64"), next: Buffer.alloc(32, 32).toString("base64"), third: Buffer.alloc(32, 33).toString("base64") };
  const next = new CredentialVault(keys, "next"), third = new CredentialVault(keys, "third");
  assert.deepEqual(await rotateSocialProgressKeys(db, next), { checked: 1, rotated: 1, skipped: 0, unavailable: 0 });
  let checkpointed = false;
  const proxied = new Proxy(db, { get(target, key) {
    if (key === "socialDeliveryProgress") return new Proxy(target.socialDeliveryProgress, { get(model, property) {
      if (property === "updateMany") return async (args: Parameters<typeof model.updateMany>[0]) => {
        if (!checkpointed) { checkpointed = true; await model.update({ where: { deliveryId: q.post.deliveries[0].id }, data: {
          encryptedState: next.encrypt(JSON.stringify({ uploadId: "resume-newer", sessionUrl: "https://upload.example.test?token=private-newer-session" }), `social-progress-v1:${q.post.deliveries[0].id}`), version: { increment: 1 } } }); }
        return model.updateMany(args);
      };
      const value = Reflect.get(model, property); return typeof value === "function" ? value.bind(model) : value;
    } });
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  assert.deepEqual(await rotateSocialProgressKeys(proxied, third), { checked: 1, rotated: 0, skipped: 1, unavailable: 0 });
  const result = await new SocialDeliveryWorker(db, third, q.r.providers, configuration, undefined, () => clock).reconcileOnce(q.post.deliveries[0].id);
  assert.equal(result?.status, "SUCCEEDED"); assert.equal((await q.s.get(q.owner.principal, q.post.id)).deliveries[0].externalId, "rotated-post");
  assert.doesNotMatch(JSON.stringify(await q.s.get(q.owner.principal, q.post.id)), /private-session|private-newer-session|resume-newer/);
});


test("an edited draft retains the original reviewed title while reconciling an older ambiguous publication", async () => {
  const q = await queued("social-title-review", { publish: async (context) => context.rpc("PUBLISH", async () => { throw new Error("unknown publication"); }),
    status: async (context) => { assert.equal(context.content.title, "Reviewed launch"); return context.rpc("PROCESS", async () => ({ status: "PUBLISHED", result: { externalId: "old-reviewed-post" } })); } });
  await worker(q.r.providers).runOnce();
  await q.s.edit(q.owner.principal, q.post.id, q.post.revision!.id, { ...q.input, title: "New unreviewed title", body: "New draft" });
  assert.equal((await worker(q.r.providers).reconcileOnce(q.post.deliveries[0].id))?.status, "SUCCEEDED");
  const current = await q.s.get(q.owner.principal, q.post.id);
  assert.equal(current.title, "New unreviewed title"); assert.equal(current.status, "DRAFT"); assert.equal(current.revision!.reviewedAt, null);
  assert.equal(current.deliveries[0].externalId, "old-reviewed-post");
});

test("a rescheduled due date changing after candidate selection prevents a stale claim", async () => {
  const q = await queued("social-claim-reschedule"); const future = new Date(clock.getTime() + 60000); let changed = false;
  const database = new Proxy(db, { get(target, property) {
    if (property === "$transaction") return (run: (tx: unknown) => Promise<unknown>) => target.$transaction(async (tx) => run(new Proxy(tx, { get(transaction, modelName) {
      if (modelName === "socialDelivery") return new Proxy(transaction.socialDelivery, { get(model, operation) {
        if (operation === "findFirst") return async (args: Parameters<typeof model.findFirst>[0]) => {
          const candidate = await model.findFirst(args);
          if (candidate && !changed) { changed = true; await model.update({ where: { id: candidate.id }, data: { dueAt: future } }); }
          return candidate;
        };
        const value = Reflect.get(model, operation); return typeof value === "function" ? value.bind(model) : value;
      } });
      const value = Reflect.get(transaction, modelName); return typeof value === "function" ? value.bind(transaction) : value;
    } })));
    const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
  } });
  assert.equal(await new SocialDeliveryWorker(database, vault, q.r.providers, configuration, undefined, () => clock).runOnce(), null);
  const waiting = await q.s.get(q.owner.principal, q.post.id); assert.equal(waiting.deliveries[0].status, "QUEUED");
  assert.equal(waiting.deliveries[0].attempts, 0); assert.equal(q.r.count(), 0);
  clock = future; assert.equal((await worker(q.r.providers).runOnce())?.status, "SUCCEEDED"); assert.equal(q.r.count(), 1);
});


test("a disabled worker leaves reviewed schedules unclaimed without consuming delivery attempts", async () => {
  const q = await queued("social-worker-paused");
  const paused = worker(q.r.providers, { ...configuration, writesEnabled: false });
  assert.equal(await paused.runOnce(), null); assert.equal(await paused.reconcileOnce(q.post.deliveries[0].id), null);
  const untouched = await q.s.get(q.owner.principal, q.post.id);
  assert.equal(untouched.deliveries[0].status, "QUEUED"); assert.equal(untouched.deliveries[0].attempts, 0); assert.equal(q.r.count(), 0);
});

test("unclassified preparation failures fail safely without automatic retry or disclosure of raw errors", async () => {
  const q = await queued("social-prepare-unknown", { prepare: async (context) => context.rpc("UPLOAD", async () => { throw new Error("private API body token=private-preparation-token"); }) });
  assert.equal((await worker(q.r.providers).runOnce())?.status, "FAILED");
  clock = new Date(clock.getTime() + 86400000); assert.equal(await worker(q.r.providers).runOnce(), null);
  const failed = await q.s.get(q.owner.principal, q.post.id);
  assert.equal(failed.deliveries[0].attempts, 1); assert.equal(failed.deliveries[0].nextAttemptAt, null); assert.equal(q.r.count(), 0);
  assert.doesNotMatch(JSON.stringify(failed), /private API|private-preparation-token/);
});

test("disconnect immediately cancels queued delivery and preserves independent authorization work", async () => {
  const q = await queued("social-lifecycle-queued", {}, 2);
  await connections.disconnect(q.owner.principal, q.destinations[0].grant.id);
  let current = await q.s.get(q.owner.principal, q.post.id);
  assert.equal(current.deliveries.find((d) => d.destinationId === q.destinations[0].dest.id)!.status, "CANCELLED");
  assert.equal(current.deliveries.find((d) => d.destinationId === q.destinations[1].dest.id)!.status, "QUEUED");
  await connections.disconnect(q.owner.principal, q.destinations[1].grant.id);
  current = await q.s.get(q.owner.principal, q.post.id); assert.equal(current.status, "CANCELLED");
  assert.equal(await worker(q.r.providers).runOnce(), null); assert.equal(q.r.count(), 0);
});

test("disconnect during a sent publish preserves uncertainty and records a known late result", async () => {
  const paused = deferred(), release = deferred(); let submissions = 0;
  const q = await queued("social-lifecycle-publish", { publish: async (context) => context.rpc("PUBLISH", async () => { submissions++; paused.resolve(); await release.promise; return { externalId: "posted-despite-disconnect" }; }) });
  const pending = worker(q.r.providers).runOnce(); await paused.promise;
  await connections.disconnect(q.owner.principal, q.destinations[0].grant.id);
  const disconnected = await q.s.get(q.owner.principal, q.post.id);
  assert.equal(disconnected.deliveries[0].status, "UNCERTAIN"); assert.equal(disconnected.deliveries[0].cancellationRequested, true);
  release.resolve(); assert.equal((await pending)?.status, "SUCCEEDED");
  assert.equal((await q.s.get(q.owner.principal, q.post.id)).deliveries[0].externalId, "posted-despite-disconnect"); assert.equal(submissions, 1);
});

test("reconnecting the same authorization cancels stale scheduled jobs before adopting its new grant", async () => {
  const q = await queued("social-lifecycle-reconnect"), original = q.destinations[0].grant;
  const oauth = { provider: "META" as const, capability: "SOCIAL" as const, redirectUri: `${origin}/api/connections/meta/callback`, scopes: ["pages_manage_posts"], pkce: false, reconnectAuthorizationId: original.id };
  const attempt = await connections.beginOAuth(q.owner.principal, oauth);
  const renewed = await connections.completeAuthorization(q.owner.principal, attempt.state, oauth, { providerUserId: original.providerUserId,
    accessToken: "new-reviewed-provider-token", scopes: oauth.scopes, connectionMode: "MOCK", expiresAt: new Date(clock.getTime() + 86400000) });
  assert.equal(renewed.id, original.id);
  const current = await q.s.get(q.owner.principal, q.post.id); assert.equal(current.deliveries[0].status, "CANCELLED"); assert.equal(current.status, "CANCELLED");
  assert.equal(await worker(q.r.providers).runOnce(), null); assert.equal(q.r.count(), 0);
});

test("verified signed Meta revocation cancels matching Social jobs while preserving successful and unrelated grants", async () => {
  const owner = await customer("social-signed-revoke"), target = await destination(owner.principal, "71001"), independent = await destination(owner.principal, "71002"), r = registry(), s = service(r.providers);
  const schedulePost = async (dest: string, key: string) => {
    const p = await s.create(owner.principal, content(dest)); await s.approve(owner.principal, p.id, p.revision!.id, [dest]);
    return s.enqueue(owner.principal, p.id, { revisionId: p.revision!.id, destinationIds: [dest], enqueueId: key, dueAt: clock.toISOString(), timeZone: "UTC" });
  };
  const completed = await schedulePost(target.dest.id, "signed-completed-job"); await worker(r.providers).runOnce();
  const cancelled = await schedulePost(target.dest.id, "signed-queued-job"), untouched = await schedulePost(independent.dest.id, "signed-independent-job");
  const payload = Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: "71001", issued_at: Math.floor(clock.getTime() / 1000) })).toString("base64url");
  const signed = `${createHmac("sha256", "fixture-signing-secret").update(payload).digest("base64url")}.${payload}`;
  const verified = verifyMetaSignedRequest(signed, "fixture-signing-secret");
  await new MetaLifecycleStore(db, { origin, mode: "mock" }, () => clock).deauthorize(verified.userId, { eventId: digest(signed), issuedAt: verified.issuedAt!.getTime() / 1000 });
  assert.equal((await s.get(owner.principal, cancelled.id)).deliveries[0].status, "CANCELLED");
  assert.equal((await s.get(owner.principal, cancelled.id)).status, "CANCELLED");
  assert.equal((await s.get(owner.principal, completed.id)).deliveries[0].status, "SUCCEEDED");
  assert.equal((await s.get(owner.principal, untouched.id)).deliveries[0].status, "QUEUED");
  assert.equal((await connections.get(owner.principal, target.grant.id)).status, "REVOKED");
  assert.equal((await connections.get(owner.principal, independent.grant.id)).status, "CONNECTED");
});


test("automatic due reconciliation recovers a status timeout without repeating publication", async () => {
  let sent = 0, polls = 0;
  const q = await queued("social-reconcile-next", { publish: async (context) => context.rpc("PUBLISH", async () => { sent++; throw new Error("publish response timed out"); }),
    status: async (context) => context.rpc("PROCESS", async () => { polls++; if (polls === 1) throw new Error("status response timed out"); return { status: "PUBLISHED", result: { externalId: "automatically-reconciled" } }; }) });
  await worker(q.r.providers).runOnce();
  assert.equal((await worker(q.r.providers).reconcileNext())?.status, "UNCERTAIN");
  assert.equal(await worker(q.r.providers).reconcileNext(), null);
  const unknown = await q.s.get(q.owner.principal, q.post.id); assert.ok(unknown.deliveries[0].nextAttemptAt);
  clock = new Date(unknown.deliveries[0].nextAttemptAt!.getTime() + 1);
  assert.equal((await worker(q.r.providers).reconcileNext())?.status, "SUCCEEDED");
  assert.equal(sent, 1); assert.equal(polls, 2); assert.equal((await q.s.get(q.owner.principal, q.post.id)).deliveries[0].externalId, "automatically-reconciled");
});


test("multi-request SDK methods recheck the private call guard before their next external request", async () => {
  const paused = deferred(), release = deferred(); let requests = 0;
  const q = await queued("social-inner-call", { prepare: async (context) => context.rpc("UPLOAD", async (call) => {
    requests++; paused.resolve(); await release.promise; await call.verifyCurrent(); requests++; return {};
  }) });
  const pending = worker(q.r.providers).runOnce(); await paused.promise;
  await connections.disconnect(q.owner.principal, q.destinations[0].grant.id); release.resolve();
  assert.equal((await pending)?.status, "LEASE_LOST"); assert.equal(requests, 1); assert.equal(q.r.count(), 0);
  const current = await q.s.get(q.owner.principal, q.post.id); assert.equal(current.deliveries[0].status, "CANCELLED");
  const attempts = await db.socialDeliveryAttempt.findMany({ where: { deliveryId: current.deliveries[0].id } });
  assert.ok(attempts.every((attempt) => attempt.status === "CANCELLED" && attempt.endedAt));
});

test("a cancelled publish lease expires into recoverable uncertainty without another send", async () => {
  const paused = deferred(), release = deferred(); let submissions = 0;
  const q = await queued("social-cancelled-lease", { publish: async (context) => context.rpc("PUBLISH", async () => {
    submissions++; paused.resolve(); await release.promise; return { externalId: "known-cancelled-publication" };
  }), status: async (context) => context.rpc("PROCESS", async () => ({ status: "PUBLISHED", result: { externalId: "known-cancelled-publication" } })) });
  const pending = worker(q.r.providers).runOnce(); await paused.promise;
  await q.s.cancel(q.owner.principal, q.post.id, [q.post.deliveries[0].id]); clock = new Date(clock.getTime() + 2000);
  try {
    assert.equal((await worker(q.r.providers).reconcileNext())?.status, "SUCCEEDED");
    assert.equal((await q.s.get(q.owner.principal, q.post.id)).deliveries[0].externalId, "known-cancelled-publication");
  } finally { release.resolve(); assert.equal((await pending)?.status, "LEASE_LOST"); }
  assert.equal(submissions, 1);
});

test("mock lease recovery never mutates expired live-mode delivery or its attempt budget", async () => {
  const q = await queued("social-recovery-mode"); const id = q.post.deliveries[0].id;
  await db.socialDelivery.update({ where: { id }, data: { connectionMode: "LIVE", status: "LEASED", phase: "UPLOAD",
    leaseTokenHash: digest("separate-live-lease"), leaseUntil: new Date(clock.getTime() - 1), attempts: 3 } });
  assert.equal(await worker(q.r.providers).runOnce(), null);
  const untouched = await db.socialDelivery.findUniqueOrThrow({ where: { id } });
  assert.equal(untouched.status, "LEASED"); assert.equal(untouched.attempts, 3); assert.equal(untouched.leaseTokenHash, digest("separate-live-lease"));
  assert.equal(untouched.errorCode, null); assert.equal(q.r.count(), 0);
});


test("an accepted publication followed by processing rate limits cannot become a duplicate send", async () => {
  let submissions = 0;
  const q = await queued("social-accepted-rate", { publish: async (context) => {
    const accepted = await context.rpc("PUBLISH", async () => { submissions++; return { externalId: "accepted-post" }; });
    await context.checkpoint({ externalId: accepted.externalId });
    await context.rpc("PROCESS", async () => { throw new SocialProviderFailure("RATE_LIMIT", true, 1000); });
    return accepted;
  }, status: async (context, progress) => context.rpc("PROCESS", async () => ({ status: "PUBLISHED", result: { externalId: progress.externalId as string } })) });
  assert.equal((await worker(q.r.providers).runOnce())?.status, "UNCERTAIN");
  clock = new Date(clock.getTime() + 2000); assert.equal(await worker(q.r.providers).runOnce(), null);
  assert.equal((await worker(q.r.providers).reconcileNext())?.status, "SUCCEEDED");
  assert.equal(submissions, 1); assert.equal((await q.s.get(q.owner.principal, q.post.id)).deliveries[0].externalId, "accepted-post");
});

test("an approval replay preserves completed state and the original reviewed timestamp", async () => {
  const q = await queued("social-approved-replay"), reviewed = q.post.revision!.reviewedAt;
  await worker(q.r.providers).runOnce(); clock = new Date(clock.getTime() + 10000);
  const replayed = await q.s.approve(q.owner.principal, q.post.id, q.post.revision!.id, [q.destinations[0].dest.id]);
  assert.equal(replayed.status, "COMPLETED"); assert.equal(replayed.revision!.reviewedAt!.getTime(), reviewed!.getTime());
  assert.equal(replayed.deliveries.length, 1); assert.equal(replayed.deliveries[0].status, "SUCCEEDED");
});


test("explicit read-only reconciliation remains available after the bounded automatic pending budget", async () => {
  let submissions = 0, complete = false;
  const q = await queued("social-manual-status", { publish: async (context) => context.rpc("PUBLISH", async () => { submissions++; throw new Error("publication outcome unknown"); }),
    status: async (context) => context.rpc("PROCESS", async () => complete ? { status: "PUBLISHED", result: { externalId: "slow-processing-post" } } : { status: "PENDING" }) });
  await worker(q.r.providers).runOnce();
  for (let i = 0; i < configuration.maxAttempts! + 2; i++) {
    assert.equal((await worker(q.r.providers).reconcileNext())?.status, "UNCERTAIN");
    const current = await q.s.get(q.owner.principal, q.post.id); clock = new Date(current.deliveries[0].nextAttemptAt!.getTime() + 1);
  }
  assert.equal(await worker(q.r.providers).reconcileNext(), null); complete = true;
  assert.equal((await worker(q.r.providers).reconcileOnce(q.post.deliveries[0].id))?.status, "SUCCEEDED");
  assert.equal(submissions, 1); assert.equal((await q.s.get(q.owner.principal, q.post.id)).deliveries[0].externalId, "slow-processing-post");
});


test("an unclassified empty rejection at the publish boundary remains uncertain", async () => {
  const q = await queued("social-empty-rejection", { publish: async (context) => context.rpc("PUBLISH", async () => { throw undefined; }) });
  assert.equal((await worker(q.r.providers).runOnce())?.status, "UNCERTAIN");
  assert.equal(await worker(q.r.providers).runOnce(), null);
});

after(async () => { await db?.$disconnect(); if (dir) await rm(dir, { recursive: true, force: true }); });


test("authoritative known processing failure keeps the receipt and blocks every resend", async () => {
  let calls = 0;
  const q = await queued("known-processing-failure", {
    publish: async (context) => context.rpc("PUBLISH", async () => {
      calls++; await context.checkpoint({ receipt: "known-processing-receipt" });
      throw new SocialProviderFailure("TRANSIENT", false);
    }),
    status: async (context) => context.rpc("PROCESS", async () => ({ status: "FAILED", result: { externalId: "known-processing-receipt" } })),
  });
  const w = worker(q.r.providers);
  assert.equal((await w.runOnce())?.status, "UNCERTAIN");
  const id = q.post.deliveries[0].id; clock = new Date(clock.getTime() + 5000);
  assert.equal((await w.reconcileOnce(id))?.status, "FAILED");
  const row = await db.socialDelivery.findUniqueOrThrow({ where: { id }, include: { progress: true } });
  assert.equal(row.externalId, "known-processing-receipt"); assert.equal(row.errorCode, "PROVIDER_PROCESSING_FAILED");
  assert.ok(row.publishStartedAt); assert.ok(row.completedAt); assert.ok(row.progress?.encryptedState);
  await assert.rejects(q.s.retry(q.owner.principal, q.post.id, [id]));
  assert.equal(await w.runOnce(), null); assert.equal(await w.reconcileOnce(id), null); assert.equal(calls, 1);
});

test("deselecting one publishing destination cancels only its unsent jobs immediately", async () => {
  const q = await queued("deselect-social-now", {}, 2);
  await connections.selectDestination(q.owner.principal, q.destinations[0].dest.id, false);
  const rows = await db.socialDelivery.findMany({ where: { postId: q.post.id } });
  assert.equal(rows.find((r) => r.destinationId === q.destinations[0].dest.id)?.status, "CANCELLED");
  assert.equal(rows.find((r) => r.destinationId === q.destinations[1].dest.id)?.status, "QUEUED");
});
