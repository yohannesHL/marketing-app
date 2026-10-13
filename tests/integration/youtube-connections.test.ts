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
import { YouTubeConnectionService, createYouTubeConnectionApi } from "../../apps/web/src/server/connections/youtubeConnectionApi";
import { YouTubeClient, YOUTUBE_SCOPES } from "../../apps/web/src/server/providers/youtube";
import { SocialPostService } from "../../apps/web/src/server/social/postService";
import { SocialDeliveryWorker } from "../../apps/web/src/server/social/deliveryWorker";
import { SocialProviderRegistry } from "../../apps/web/src/server/social/types";
import { applyConnectionMigrations } from "../support/test-database";
import { startMockoon } from "../support/mockoon";

let directory: string, db: PrismaClient, auth: CustomerAuth, connections: CustomerConnections,
  state: ProviderConnectionState, social: SocialConnectionState, client: YouTubeClient, service: YouTubeConnectionService,
  api: ReturnType<typeof createYouTubeConnectionApi>, vault: CredentialVault;
let mock: Awaited<ReturnType<typeof startMockoon>>;
let clock = new Date("2026-10-13T12:00:00Z");
const origin = "https://launchpad.test";
before(async () => {
  mock = await startMockoon("tests/mockoon/youtube.json"); directory = await mkdtemp(join(tmpdir(), "youtube-connections-"));
  const url = `file:${join(directory, "test.db")}`, sql = createClient({ url });
  await applyConnectionMigrations(sql); sql.close(); db = new PrismaClient({ adapter: new PrismaLibSql({ url }) });
  vault = new CredentialVault({ test: Buffer.alloc(32, 46).toString("base64") }, "test");
  auth = new CustomerAuth(db, { origin }, () => clock); connections = new CustomerConnections(db, auth, vault, () => clock);
  state = new ProviderConnectionState(db, auth, vault, () => clock); social = new SocialConnectionState(db, auth, () => clock);
  client = new YouTubeClient({ clientId: "yt-client", clientSecret: "fixture-yt-secret", redirectUri: `${origin}/api/connections/youtube/callback`,
    mockoonEnabled: true, mockoonBaseUrl: mock.origin, now: () => clock });
  service = new YouTubeConnectionService(auth, connections, state, social, client, "mock", () => clock);
  api = createYouTubeConnectionApi(auth, service);
});
after(async () => { await mock?.stop(); await db?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });
async function customer(name: string) {
  await auth.provisionCustomer({ email: `${name}@example.test`, name, password: "independent youtube connection fixtures" });
  const login = await auth.login(`${name}@example.test`, "independent youtube connection fixtures"), cookie = login.cookie.split(";")[0];
  const principal = await auth.requireSession(new Request(origin, { headers: { cookie } }));
  const request = (path: string, body: unknown = {}, method = "POST") => new Request(`${origin}${path}`, {
    method, headers: { cookie, Origin: origin, "Content-Type": "application/json" }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
  return { principal, cookie, request };
}
async function connected(name: string) {
  const owner = await customer(name), start = await service.start(owner.principal);
  const consentState = new URL(start.authorizationUrl).searchParams.get("state")!;
  const result = await service.complete(owner.principal, consentState, "success");
  return { owner, result, consentState };
}

test("YouTube OAuth is authenticated, origin-bound, SOCIAL-only and returns actual safe channel metadata", async () => {
  const owner = await customer("yt-oauth");
  assert.equal((await api(new Request(`${origin}/api/connections/youtube/start`, { method: "POST" }))).status, 401);
  assert.equal((await api(new Request(`${origin}/api/connections/youtube/start`, { method: "POST", headers: { cookie: owner.cookie, Origin: "https://other.test" } }))).status, 403);
  assert.equal((await api(owner.request("/api/connections/youtube/start", { accessToken: "forged" }))).status, 400);
  const start = await service.start(owner.principal), query = new URL(start.authorizationUrl);
  const result = await api(owner.request(`/api/connections/youtube/callback?state=${query.searchParams.get("state")}&code=success`, {}, "GET"));
  assert.equal(result.status, 200); const body = await result.json();
  assert.equal(body.connection.capability, "SOCIAL"); assert.deepEqual(body.connection.scopes, [...YOUTUBE_SCOPES].sort());
  assert.equal(body.connection.destinations[0].externalId, "UCfixtureBrandA"); assert.equal(body.connection.destinations[0].selected, false);
  assert.equal(body.connection.destinations[0].metadata.canWrite, "ALLOWED");
  assert.doesNotMatch(JSON.stringify(body), /yt-access|yt-refresh|Ciphertext|fixture-yt-secret/);
});

test("callbacks cannot cross customers, replay consent, or retain declined exchange state", async () => {
  const a = await customer("yt-state-a"), b = await customer("yt-state-b"), start = await service.start(a.principal);
  const value = new URL(start.authorizationUrl).searchParams.get("state")!;
  await assert.rejects(service.complete(b.principal, value, "success"), { code: "INVALID_OAUTH_STATE" });
  await assert.rejects(service.complete(a.principal, value, undefined, true), { code: "CONSENT_DENIED" });
  await assert.rejects(service.complete(a.principal, value, "success"), { code: "INVALID_OAUTH_STATE" });
  const q = await connected("yt-replay");
  await assert.rejects(service.complete(q.owner.principal, q.consentState, "success"), { code: "INVALID_OAUTH_STATE" });
});

test("selection and discovery reject foreign destinations, Ads grants and mixed provider modes", async () => {
  const a = await connected("yt-select-a"), b = await connected("yt-select-b"), id = a.result.connection.id;
  await assert.rejects(service.refresh(a.owner.principal, id, b.result.connection.destinations[0].id, true), { code: "NOT_FOUND" });
  const selected = await service.refresh(a.owner.principal, id, a.result.connection.destinations[0].id, true);
  assert.equal(selected.connection.destinations[0].selected, true);
  const oauth = { provider: "GOOGLE" as const, capability: "ADS" as const, scopes: ["openid"], pkce: false, redirectUri: `${origin}/api/connections/google/callback` };
  const attempt = await connections.beginOAuth(a.owner.principal, oauth), ads = await connections.completeAuthorization(a.owner.principal, attempt.state, oauth,
    { providerUserId: "google-sub-a", accessToken: "ads-only-token", scopes: ["openid"], connectionMode: "MOCK" });
  await assert.rejects(service.refresh(a.owner.principal, ads.id), { code: "NOT_FOUND" });
  const live = new YouTubeConnectionService(auth, connections, state, social, client, "live", () => clock);
  await assert.rejects(live.refresh(a.owner.principal, id), { code: "CONNECTION_MODE_MISMATCH" });
});

test("ambiguous multiple-channel consent stays ineligible and channel selection cannot retarget an upload token", async () => {
  const q = await connected("yt-multiple");
  await connections.updateCredentials(q.result.connection.id, q.result.connection.credentialVersion, {
    accessToken: "yt-pagination", refreshToken: "yt-refresh-a", scopes: [...YOUTUBE_SCOPES], expiresAt: new Date(clock.getTime() + 3600000) });
  const result = await service.refresh(q.owner.principal, q.result.connection.id);
  assert.equal(result.connection.destinations.length, 2);
  assert.ok(result.connection.destinations.every((item) => !item.selected && !item.available && item.metadata &&
    (item.metadata as { canWrite: string }).canWrite === "DENIED"));
  await assert.rejects(service.refresh(q.owner.principal, q.result.connection.id, result.connection.destinations[0].id, true), { code: "CHANNEL_MISMATCH" });
});

test("browser callbacks keep provider codes and state out of redirect URLs", async () => {
  const owner = await customer("yt-browser"), start = await service.start(owner.principal), value = new URL(start.authorizationUrl).searchParams.get("state")!;
  const request = new Request(`${origin}/api/connections/youtube/callback?state=${value}&error=access_denied&error_description=private-provider-message`,
    { headers: { cookie: owner.cookie, Accept: "text/html" } });
  const response = await api(request); assert.equal(response.status, 303);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("location"), `${origin}/connections?provider=youtube&result=failed&error=CONSENT_DENIED`);
});

test("a renewable scheduled authorization runs after browser logout and expiry using verified private renewal", async () => {
  const q = await connected("yt-scheduled"), destination = q.result.connection.destinations[0];
  await service.refresh(q.owner.principal, q.result.connection.id, destination.id, true);
  const asset = await db.socialMediaAsset.create({ data: { ownerId: q.owner.principal.userId, storageKey: "trusted-test-media", digest: "a".repeat(64),
    bytes: 8, mime: "video/mp4", type: "VIDEO", width: 320, height: 480, durationMs: 1000, status: "AVAILABLE", verifiedAt: clock } });
  const registry = new SocialProviderRegistry(); let sends = 0, renewals = 0;
  // This isolates the queue/renewal contract; real upload and processing HTTP are covered by the adapter suite.
  registry.register({ platform: "GOOGLE", kind: "YOUTUBE_CHANNEL", requiredScopes: [...YOUTUBE_SCOPES], formats: ["SHORT_VIDEO"], modes: ["mock"], renewableCredentials: true,
    factory: () => ({ validate: async (context) => { await context.rpc("PREPARE", async (call) => { assert.equal(call.accessToken, "yt-access-a"); }); },
      prepare: async () => ({}), publish: async (context) => context.rpc("PUBLISH", async () => { sends++; return { externalId: "renewed-queue-proof" }; }),
      status: async () => ({ status: "UNKNOWN" }) }) });
  const config = { mode: "mock" as const, writesEnabled: true, approvedProviders: ["GOOGLE:YOUTUBE_CHANNEL"] }, posts = new SocialPostService(db, auth, config, registry, () => clock);
  const post = await posts.create(q.owner.principal, { title: "Scheduled renewal", body: "Reviewed content", mediaIds: [asset.id], variants: [{ destinationId: destination.id, format: "SHORT_VIDEO" }] });
  await posts.approve(q.owner.principal, post.id, post.revision!.id, [destination.id]);
  const due = new Date(clock.getTime() + 2 * 86400000);
  await posts.enqueue(q.owner.principal, post.id, { revisionId: post.revision!.id, destinationIds: [destination.id], enqueueId: "renewal-scheduled-key", dueAt: due.toISOString(), timeZone: "UTC" });
  await auth.logout(q.owner.principal); clock = due;
  const worker = new SocialDeliveryWorker(db, vault, registry, config, async ({ media }) => media.map((item) => ({ id: item.id, url: `${mock.origin}/fixture-media` })), () => clock,
    async (request) => { renewals++; return new YouTubeClient({ clientId: "yt-client", clientSecret: "fixture-yt-secret", redirectUri: `${origin}/api/connections/youtube/callback`,
      mockoonEnabled: true, mockoonBaseUrl: mock.origin, now: () => clock, beforeRequest: request.verifyCurrent }).renewVerified({ providerUserId: request.providerUserId, refreshToken: request.refreshToken, scopes: request.scopes }); });
  assert.equal((await worker.runOnce())?.status, "SUCCEEDED"); assert.equal(renewals, 1); assert.equal(sends, 1);
  const row = await db.providerAuthorization.findUniqueOrThrow({ where: { id: q.result.connection.id } });
  assert.ok(row.expiresAt && row.expiresAt > clock); assert.ok(row.credentialVersion > q.result.connection.credentialVersion);
  assert.doesNotMatch(JSON.stringify(await db.socialDelivery.findMany({ where: { postId: post.id } })), /yt-access|yt-refresh/);
});
