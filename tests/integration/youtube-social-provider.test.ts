import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../../apps/web/src/generated/prisma/client";
import { CustomerAuth } from "../../apps/web/src/server/auth/customerAuth";
import { CustomerConnections } from "../../apps/web/src/server/connections/customerConnections";
import { CredentialVault } from "../../apps/web/src/server/security/credentialVault";
import { SocialPostService } from "../../apps/web/src/server/social/postService";
import { SocialDeliveryWorker } from "../../apps/web/src/server/social/deliveryWorker";
import { YOUTUBE_SCOPES } from "../../apps/web/src/server/providers/youtube";
import { applyConnectionMigrations } from "../support/test-database";
import { YouTubeSocialProvider, youtubeSocialRegistration } from "../../apps/web/src/server/social/providers/youtube";
import { SocialProviderRegistry, SocialProviderFailure, type SocialProviderContext, type SocialProviderCall, type SocialProgress } from "../../apps/web/src/server/social/types";
import { startMockoon } from "../support/mockoon";
let mock: Awaited<ReturnType<typeof startMockoon>>;
let directory: string, db: PrismaClient;
before(async () => {
  mock = await startMockoon("tests/mockoon/youtube.json");
  directory = await mkdtemp(join(tmpdir(), "youtube-social-provider-"));
  const url = `file:${join(directory, "test.db")}`;
  const sql = createClient({ url }); await applyConnectionMigrations(sql); sql.close();
  db = new PrismaClient({ adapter: new PrismaLibSql({ url }) });
});
after(async () => { await mock?.stop(); await db?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });
const config = () => ({ clientId: "yt-client", clientSecret: "fixture-yt-secret", redirectUri: "https://launchpad.test/api/connections/youtube/callback",
  mockoonEnabled: true, mockoonBaseUrl: mock.origin, now: () => new Date("2026-10-13T12:00:00Z") });
function harness(privacy = "private", patch: Partial<SocialProviderCall> = {}, scenario = privacy) {
  const saved: SocialProgress[] = [];
  const events: string[] = [];
  const call: SocialProviderCall = { mode: "mock", accessToken: "yt-access-a", verifyCurrent: async () => { events.push("guard"); },
    destination: { externalId: "UCfixtureBrandA", kind: "YOUTUBE_CHANNEL", metadata: {} },
    media: [{ id: "media-fixture", url: `${mock.origin}/api/social/media/media-fixture/content?expires=1791979200&signature=${"a".repeat(64)}`,
      mime: "video/mp4", bytes: 262151, width: 1080, height: 1920, durationMs: 180000 }], ...patch };
  const context: SocialProviderContext = { deliveryId: `delivery-${scenario}`, revisionId: `revision-${scenario}`,
    content: { title: `Adapter ${scenario}`, body: "Synthetic fixture", format: "SHORT_VIDEO", providerOptions: {
      categoryId: "22", privacyStatus: privacy === "pending" ? "private" : privacy, madeForKids: false, containsSyntheticMedia: true } },
    rpc: async (phase, invoke) => { events.push(phase); return invoke(call); },
    checkpoint: async (progress) => { events.push("checkpoint"); saved.push(structuredClone(progress)); } };
  return { context, call, saved, events, provider: new YouTubeSocialProvider(config(), { mediaOrigin: mock.origin }) };
}

test("YouTube adapter saves the session before chunks and proves the requested private/public/unlisted visibility", async () => {
  for (const privacy of ["private", "public", "unlisted"]) {
    const h = harness(privacy);
    await h.provider.validate(h.context);
    const prepared = await h.provider.prepare(h.context, {});
    const result = await h.provider.publish(h.context, prepared);
    assert.equal(result.externalId, `adapterVideo${privacy[0].toUpperCase()}${privacy.slice(1)}`);
    assert.equal(h.events.filter((event) => event === "PUBLISH").length, 1);
    const sessionIndex = h.saved.findIndex((progress) => typeof progress.sessionUrl === "string");
    assert.equal(h.saved[sessionIndex].offset, 0);
    assert.equal(h.saved.at(-1)?.videoId, result.externalId);
    const serial = JSON.stringify(h.saved);
    assert.equal(serial.includes("yt-access-a"), false);
    assert.equal(serial.includes("signature="), false);
    assert.equal(serial.includes("publishAt"), false);
    assert.equal((await h.provider.status(h.context, h.saved.at(-1)!)).status, "PUBLISHED");
  }
});

test("accepted upload IDs remain saved while processing is pending; status cannot infer publication from the receipt", async () => {
  const h = harness("pending");
  await h.provider.validate(h.context);
  const prepared = await h.provider.prepare(h.context, {});
  await assert.rejects(h.provider.publish(h.context, prepared), (error: unknown) =>
    error instanceof SocialProviderFailure && error.kind === "TRANSIENT" && !error.definitive);
  assert.equal(h.saved.at(-1)?.videoId, "adapterVideoPending");
  assert.equal((await h.provider.status(h.context, h.saved.at(-1)!)).status, "PENDING");
  assert.equal(h.events.filter((e) => e === "PUBLISH").length, 1);
  assert.deepEqual(await h.provider.status(h.context, {}), { status: "UNKNOWN" });
});

test("worker interruption before chunks reconciles and resumes the same saved session without another initiation", async () => {
  const h = harness("private", {}, "resume");
  await h.provider.validate(h.context);
  const prepared = await h.provider.prepare(h.context, {});
  const checkpoint = h.context.checkpoint;
  h.context.checkpoint = async (progress) => { await checkpoint(progress); throw new Error("Simulated durable worker interruption"); };
  await assert.rejects(h.provider.publish(h.context, prepared), /Simulated durable worker interruption/);
  assert.equal(h.saved.at(-1)?.offset, 0);
  const restarted = harness("private", {}, "resume");
  assert.deepEqual(await restarted.provider.status(restarted.context, h.saved.at(-1)!), { status: "NOT_PUBLISHED" });
  assert.equal(restarted.saved.at(-1)?.offset, 262144);
  const loaded = await restarted.provider.prepare(restarted.context, restarted.saved.at(-1)!);
  assert.equal((await restarted.provider.publish(restarted.context, loaded)).externalId, "adapterVideoResume");
  assert.equal(restarted.events.includes("PUBLISH"), false);
  assert.equal(restarted.events.filter((e) => e === "UPLOAD").length, 1);
});

test("mode, channel, Ads-only scopes, untrusted media URLs and mismatched saved evidence fail closed", async () => {
  const live = harness("private", { mode: "live" });
  await assert.rejects(live.provider.validate(live.context), { code: "CONNECTION_MODE_MISMATCH" });
  const wrong = harness("private", { destination: { kind: "YOUTUBE_CHANNEL", externalId: "UCfixtureChannelB", metadata: {} } });
  await assert.rejects(wrong.provider.validate(wrong.context), (error: unknown) => error instanceof SocialProviderFailure && error.kind === "TERMINAL");
  const ads = harness("private", { accessToken: "ads-only-token" });
  await assert.rejects(ads.provider.validate(ads.context), { code: "MISSING_PERMISSION" });
  const untrusted = harness();
  untrusted.call.media[0].url = "https://attacker.test/secret";
  await assert.rejects(untrusted.provider.prepare(untrusted.context, {}), { code: "MEDIA_UNAVAILABLE" });
  const safe = harness();
  const prepared = await safe.provider.prepare(safe.context, {});
  await assert.rejects(safe.provider.status(safe.context, { ...prepared, sessionUrl: `${mock.origin}/upload/youtube/v3/videos?uploadType=resumable&upload_id=expired-session` }),
    (error: unknown) => error instanceof SocialProviderFailure && !error.definitive);
  await assert.rejects(safe.provider.status(safe.context, { ...prepared, videoId: "publishedVideo", channelId: "UCfixtureChannelB" }), { code: "INVALID_PROVIDER_PROGRESS" });
  const wrongPrivacy = await safe.provider.status(safe.context, { ...prepared, videoId: "publishedVideo" });
  assert.deepEqual(wrongPrivacy, { status: "UNKNOWN" });
});

test("real durable worker keeps accepted upload plus pending, 429 or timed-out processing UNCERTAIN without initiating again", async () => {
  const now = () => new Date("2026-10-13T12:00:00Z"), origin = "https://launchpad.test";
  const auth = new CustomerAuth(db, { origin }, now);
  const vault = new CredentialVault({ test: Buffer.alloc(32, 53).toString("base64") }, "test");
  const connections = new CustomerConnections(db, auth, vault, now);
  for (const scenario of ["worker-pending", "worker-rate", "worker-timeout"]) {
    const email = `${scenario}@example.test`, password = "isolated YouTube delivery customer password";
    await auth.provisionCustomer({ name: scenario, email, password });
    const login = await auth.login(email, password);
    const principal = await auth.requireSession(new Request(origin, { headers: { cookie: login.cookie.split(";")[0] } }));
    const oauth = { provider: "GOOGLE" as const, capability: "SOCIAL" as const, redirectUri: config().redirectUri, scopes: [...YOUTUBE_SCOPES], pkce: true };
    const start = await connections.beginOAuth(principal, oauth);
    const grant = await connections.completeAuthorization(principal, start.state, oauth, { providerUserId: `google-sub-${scenario}`,
      accessToken: "yt-access-a", refreshToken: "yt-refresh-a", scopes: [...YOUTUBE_SCOPES], connectionMode: "MOCK", expiresAt: new Date("2026-10-14T12:00:00Z") });
    const destination = await connections.registerDestination(principal, grant.id, { externalId: "UCfixtureBrandA", name: "Synthetic channel", kind: "YOUTUBE_CHANNEL" });
    await db.connectionDestination.update({ where: { id: destination.id }, data: { selected: true, metadata: { canWrite: "ALLOWED" }, lastCheckedAt: now() } });
    // Trusted database fixture for the worker/provider contract. Actual decode,
    // hashing and signed-link generation have independent real media-store tests.
    const media = await db.socialMediaAsset.create({ data: { ownerId: principal.userId, storageKey: `fixture-${scenario}`,
      digest: "a".repeat(64), bytes: 262151, mime: "video/mp4", type: "VIDEO", width: 1080, height: 1920,
      durationMs: 180000, verifiedAt: now(), status: "AVAILABLE" } });
    const providers = new SocialProviderRegistry();
    providers.register(youtubeSocialRegistration({ ...config(), requestTimeoutMs: 1000 }, { mediaOrigin: mock.origin }));
    const configuration = { mode: "mock" as const, writesEnabled: true, approvedProviders: ["GOOGLE:YOUTUBE_CHANNEL"] };
    const service = new SocialPostService(db, auth, configuration, providers, now);
    const post = await service.create(principal, { title: `Adapter ${scenario}`, body: "Synthetic fixture", mediaIds: [media.id],
      variants: [{ destinationId: destination.id, format: "SHORT_VIDEO", providerOptions: {
        categoryId: "22", privacyStatus: "private", madeForKids: false, containsSyntheticMedia: true } }] });
    await service.approve(principal, post.id, post.revision!.id, [destination.id]);
    const queued = await service.enqueue(principal, post.id, { revisionId: post.revision!.id, destinationIds: [destination.id],
      enqueueId: scenario, dueAt: now().toISOString(), timeZone: "UTC" });
    const worker = () => new SocialDeliveryWorker(db, vault, providers, configuration,
      async ({ media: assets }) => assets.map((asset) => ({ id: asset.id,
        url: `${mock.origin}/api/social/media/${asset.id}/content?expires=1791979200&signature=${"a".repeat(64)}` })), now);
    assert.equal((await worker().runOnce())?.status, "UNCERTAIN");
    const id = queued.deliveries[0].id;
    const delivery = await db.socialDelivery.findUniqueOrThrow({ where: { id } });
    assert.equal(delivery.phase, "PUBLISH"); assert.ok(delivery.publishStartedAt);
    const encrypted = await db.socialDeliveryProgress.findUniqueOrThrow({ where: { deliveryId: id } });
    assert.equal(encrypted.encryptedState.includes("adapterVideo"), false);
    const progress = JSON.parse(vault.decrypt(encrypted.encryptedState, `social-progress-v1:${id}`));
    assert.equal(progress.videoId, `adapterVideo${scenario.split("-").map((word) => word[0].toUpperCase() + word.slice(1)).join("")}`);
    assert.equal(await worker().runOnce(), null);
    assert.equal((await worker().reconcileOnce(id))?.status, "UNCERTAIN");
    assert.equal(await worker().runOnce(), null);
    await assert.rejects(service.retry(principal, post.id, [id]), { code: "RECONCILIATION_REQUIRED" });
    const publicPost = await service.get(principal, post.id);
    assert.doesNotMatch(JSON.stringify(publicPost), /yt-access-a|yt-refresh-a|signature=|sessionUrl|private-provider-secret/);
  }
});

test("a stale authorization between initiation and the next provider read stops sending bytes while preserving the session", async () => {
  const h = harness("private", {}, "guard");
  const prepared = await h.provider.prepare(h.context, {});
  // A saved session from an interrupted delivery is sufficient to test the
  // per-request guard without issuing a fresh initialization.
  const progress = { ...prepared, sessionUrl: `${mock.origin}/upload/youtube/v3/videos?uploadType=resumable&upload_id=adapter-private` };
  const stale = Object.assign(new Error("The connection changed."), { code: "STALE_CREDENTIALS" });
  h.call.verifyCurrent = async () => { throw stale; };
  await assert.rejects(h.provider.publish(h.context, progress), (error: unknown) => error === stale);
  assert.equal(h.events.includes("UPLOAD"), false);
  assert.equal(h.events.includes("PUBLISH"), false);
});


test("verified rejected YouTube video is a terminal known failure with its receipt retained", async () => {
  const h = harness();
  const prepared = await h.provider.prepare(h.context, {});
  assert.deepEqual(await h.provider.status(h.context, { ...prepared, videoId: "failedVideo" }),
    { status: "FAILED", result: { externalId: "failedVideo" } });
  assert.equal(h.events.includes("PUBLISH"), false);
});
