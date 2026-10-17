import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { applyConnectionMigrations } from "../support/test-database";
import { PrismaClient } from "../../apps/web/src/generated/prisma/client";
import { LocalSqliteAdapter } from "../../apps/web/src/server/prisma/localSqliteAdapter";
import { CustomerAuth } from "../../apps/web/src/server/auth/customerAuth";
import { WorkspaceService } from "../../apps/web/src/server/workspace/service";
import { createWorkspaceApi } from "../../apps/web/src/server/workspace/api";

const origin = "https://workspace.test";
let directory: string;
let url: string;
let db: PrismaClient;
let api: ReturnType<typeof createWorkspaceApi>;
let alice: { id: string; cookie: string };
let bob: { id: string; cookie: string };

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "launchpad-workspace-"));
  url = `file:${join(directory, "workspace.db")}`;
  const client = createClient({ url });
  await applyConnectionMigrations(client); client.close();
  db = new PrismaClient({ adapter: new LocalSqliteAdapter({ url }) });
  const auth = new CustomerAuth(db, { origin });
  api = createWorkspaceApi(auth, new WorkspaceService(db));
  const provision = async (name: string) => {
    const email = `${name}@example.test`;
    const customer = await auth.provisionCustomer({ email, name, password: "workspace integration password" });
    const login = await auth.login(email, "workspace integration password");
    return { id: customer.id, cookie: login.cookie.split(";")[0] };
  };
  alice = await provision("alice"); bob = await provision("bob");
});
after(async () => { await db?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });
function request(path: string, method = "GET", body?: unknown, customer = alice, requestOrigin = origin) {
  return new Request(`${origin}/api/workspace/${path}`, { method, headers: { cookie: customer.cookie, origin: requestOrigin, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function create(overrides: Record<string, unknown> = {}) {
  const response = await api(request("campaigns", "POST", { type: "SOCIAL", name: "Autumn studio launch", websiteUrl: "https://example.test/launch", brief: "Introduce our autumn collection.", platforms: ["INSTAGRAM"], ...overrides }));
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  return (await response.json()).campaign;
}

test("campaigns persist across a new database client, isolate owners, and reject identity injection", async () => {
  const campaign = await create({ creatives: [{ platform: "INSTAGRAM", body: "Meet the autumn collection." }], plan: { cadence: "weekly", budget: 0 } });
  assert.equal(campaign.version, 1); assert.equal(campaign.status, "DRAFT"); assert.equal("ownerId" in campaign, false);
  const second = new PrismaClient({ adapter: new LocalSqliteAdapter({ url }) });
  try {
    const secondApi = createWorkspaceApi(new CustomerAuth(second, { origin }), new WorkspaceService(second));
    const response = await secondApi(request(`campaigns/${campaign.id}`));
    assert.equal(response.status, 200); assert.deepEqual((await response.json()).campaign.creatives, campaign.creatives);
  } finally { await second.$disconnect(); }
  assert.equal((await api(request(`campaigns/${campaign.id}`, "GET", undefined, bob))).status, 404);
  assert.equal((await api(request(`campaigns/${campaign.id}`, "PATCH", { version: 1, name: "stolen" }, bob))).status, 404);
  assert.deepEqual((await (await api(request("campaigns", "GET", undefined, bob))).json()).campaigns, []);
  assert.equal((await api(request("campaigns", "POST", { name: "Injected", ownerId: bob.id }))).status, 400);
  assert.equal((await api(request(`campaigns/${campaign.id}`, "PATCH", { version: 1, ownerId: bob.id }))).status, 400);
});

test("concurrent draft saves accept only one revision and stale writes preserve the saved plan", async () => {
  const campaign = await create();
  const results = await Promise.all([
    api(request(`campaigns/${campaign.id}`, "PATCH", { version: 1, name: "Window A", plan: { cadence: "daily" } })),
    api(request(`campaigns/${campaign.id}`, "PATCH", { version: 1, name: "Window B", plan: { cadence: "weekly" } })),
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const saved = (await (await api(request(`campaigns/${campaign.id}`))).json()).campaign;
  assert.equal(saved.version, 2);
  assert.equal(saved.plan.cadence, saved.name === "Window A" ? "daily" : "weekly");
  assert.equal((await api(request(`campaigns/${campaign.id}`, "PATCH", { version: 1, brief: "stale overwrite" }))).status, 409);
  assert.equal((await api(request(`campaigns/${campaign.id}`, "PATCH", { name: "missing version" }))).status, 400);
});

test("workspace mutations enforce origin and authentication, validate URLs, content, and type-specific channels", async () => {
  assert.equal((await api(new Request(`${origin}/api/workspace/summary`))).status, 401);
  assert.equal((await api(request("campaigns", "POST", { name: "Cross-site" }, alice, "https://other.test"))).status, 403);
  for (const invalid of [
    { type: "ADS", platforms: ["YOUTUBE"] }, { type: "EMAIL", platforms: ["GOOGLE"] },
    { type: "UNKNOWN" }, { websiteUrl: "javascript:alert(1)" }, { websiteUrl: "https://user:secret@example.test" },
    { brief: "a".repeat(10001) }, { platforms: ["X", "X"] }, { creatives: ["unstructured"] },
    { status: "RUNNING" }, { status: "READY", websiteUrl: "" }, { plan: [] },
    { plan: { nested: { content: "x".repeat(24001) } } }, { creatives: [{ content: "x".repeat(24001) }] },
  ]) assert.equal((await api(request("campaigns", "POST", { name: "Invalid campaign", ...invalid }))).status, 400, JSON.stringify(invalid).slice(0, 100));
  const ready = await create({ status: "READY" });
  assert.equal(ready.status, "READY"); assert.equal(ready.execution.mode, "SOCIAL_APPROVAL");
  const email = await create({ type: "EMAIL", platforms: ["EMAIL"] });
  assert.equal(email.execution.mode, "DRAFT_ONLY");
  const oversized = await api(request("campaigns", "POST", { name: "huge", brief: "x".repeat(40000) }));
  assert.equal(oversized.status, 413);
});

test("linking social posts validates ownership and cannot mutate or publish those posts", async () => {
  const own = await db.socialPost.create({ data: { ownerId: alice.id, title: "Our approved plan" } });
  const foreign = await db.socialPost.create({ data: { ownerId: bob.id, title: "Other customer's plan" } });
  assert.equal((await api(request("campaigns", "POST", { name: "Forged link", socialPostIds: [foreign.id] }))).status, 404);
  const campaign = await create({ socialPostIds: [own.id] });
  assert.deepEqual(campaign.socialPostIds, [own.id]);
  assert.equal(campaign.linkedPosts[0].title, own.title);
  assert.equal((await db.socialPost.findUniqueOrThrow({ where: { id: own.id } })).status, "DRAFT");
  assert.equal((await api(request(`campaigns/${campaign.id}`, "PATCH", { version: 1, socialPostIds: [foreign.id] }))).status, 404);
  assert.equal((await api(request("campaigns", "POST", { type: "ADS", name: "Wrong type", socialPostIds: [own.id] }))).status, 400);
});

test("brand kit persists with independent owner versions and rejects concurrent first saves", async () => {
  const fresh = await (await api(request("brand"))).json(); assert.equal(fresh.brand.version, 0);
  const results = await Promise.all([
    api(request("brand", "PATCH", { version: 0, name: "Rosehill", colors: ["#426B53"], voice: "Calm and direct" })),
    api(request("brand", "PATCH", { version: 0, name: "Rosehill alternate" })),
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const saved = (await (await api(request("brand"))).json()).brand; assert.equal(saved.version, 1); assert.equal("ownerId" in saved, false);
  assert.equal((await api(request("brand", "PATCH", { version: 0, name: "stale" }))).status, 409);
  assert.equal((await api(request("brand", "PATCH", { version: 1, logoUrl: "data:image/svg+xml,unsafe" }))).status, 400);
  assert.equal((await api(request("brand", "PATCH", { version: 1, colors: ["red"] }))).status, 400);
  assert.equal((await (await api(request("brand", "GET", undefined, bob))).json()).brand.version, 0);
});

test("summary returns actual scoped data without connection credentials or storage internals", async () => {
  await db.socialMediaAsset.create({ data: { ownerId: alice.id, storageKey: "private-storage-key", digest: "private-digest", bytes: 100, mime: "image/png", type: "IMAGE", width: 10, height: 10, status: "AVAILABLE", filename: "collection.png" } });
  await db.socialMediaAsset.create({ data: { ownerId: bob.id, storageKey: "foreign-storage-key", digest: "foreign-digest", bytes: 100, mime: "image/png", type: "IMAGE", width: 10, height: 10, status: "AVAILABLE", filename: "foreign.png" } });
  await db.providerAuthorization.create({ data: { userId: alice.id, provider: "META", providerUserId: "private-provider-user", capability: "SOCIAL", connectionMode: "MOCK", scopes: ["private-scope"], accessCiphertext: "private-access", refreshCiphertext: "private-refresh", destinations: { create: { externalId: "private-external-id", kind: "FACEBOOK_PAGE", name: "Our Facebook Page", selected: true } } } });
  const response = await api(request("summary"));
  assert.equal(response.headers.get("cache-control"), "no-store");
  const summary = await response.json();
  assert.equal(summary.counts.campaigns, await db.workspaceCampaign.count({ where: { ownerId: alice.id } }));
  assert.equal(summary.counts.mediaAssets, 1); assert.equal(summary.counts.connectedChannels, 1);
  assert.equal(summary.media[0].filename, "collection.png"); assert.equal(summary.performance, null); assert.equal(summary.counts.activeCampaigns, 0);
  const serialized = JSON.stringify(summary);
  for (const forbidden of ["private-", "foreign-", "foreign.png", "storageKey", "Ciphertext", "ownerId", "providerUserId", "externalId", "Other customer's plan"]) assert.equal(serialized.includes(forbidden), false, forbidden);
});

test("active campaign counts follow real linked delivery state, including posts outside the recent window", async () => {
  const auth = await db.providerAuthorization.create({ data: { userId: alice.id, provider: "GOOGLE", providerUserId: "active-channel", capability: "SOCIAL", connectionMode: "MOCK", scopes: [], destinations: { create: { externalId: "active-channel", kind: "YOUTUBE_CHANNEL", name: "Active channel", selected: true } } }, include: { destinations: true } });
  const destinationId = auth.destinations[0].id;
  const post = await db.socialPost.create({ data: { ownerId: alice.id, title: "Scheduled launch", status: "SCHEDULED", updatedAt: new Date("2020-01-01"), revisions: { create: { number: 1, title: "Scheduled launch", body: "Approved launch", contentDigest: "digest", variants: { create: { destinationId, format: "SHORT_VIDEO", body: "Launch", mediaIds: [] } } } } }, include: { revisions: { include: { variants: true } } } });
  const revisionId = post.revisions[0].id;
  const enqueue = await db.socialEnqueue.create({ data: { ownerId: alice.id, key: "active-campaign-key", postId: post.id, revisionId, requestDigest: "digest", dueAt: new Date(), timeZone: "Europe/London", destinationIds: [destinationId] } });
  const delivery = await db.socialDelivery.create({ data: { postId: post.id, revisionId, variantId: post.revisions[0].variants[0].id, destinationId, enqueueId: enqueue.id, authorizationId: auth.id, authorizationGeneration: 1, postGeneration: 1, connectionMode: "MOCK", requiredScopes: [], dueAt: new Date(), timeZone: "Europe/London", status: "QUEUED" } });
  await create({ name: "Real scheduled campaign", socialPostIds: [post.id] });
  await db.socialPost.createMany({ data: Array.from({ length: 101 }, (_, i) => ({ ownerId: alice.id, title: `Recent draft ${i}` })) });
  assert.equal((await (await api(request("summary"))).json()).counts.activeCampaigns, 1);
  await db.socialDelivery.update({ where: { id: delivery.id }, data: { status: "FAILED" } });
  assert.equal((await (await api(request("summary"))).json()).counts.activeCampaigns, 0);
});

test("mock writing assistance is authenticated, origin checked, and absent in live or unset modes", async () => {
  const campaign = { type: "SOCIAL", name: "Studio open day", websiteUrl: "https://example.test", brief: "Visit the studio on Saturday to see our ceramic collection.", goal: "awareness", audience: "Local visitors", platforms: ["INSTAGRAM"] };
  const mockApi = createWorkspaceApi(new CustomerAuth(db, { origin }), new WorkspaceService(db, "mock"));
  assert.equal((await mockApi(new Request(`${origin}/api/workspace/assist`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ action: "BRIEF", campaign }) }))).status, 401);
  assert.equal((await mockApi(request("assist", "POST", { action: "BRIEF", campaign }, alice, "https://attacker.test"))).status, 403);
  for (const mode of ["live", "", "MOCK"]) {
    const disabledApi = createWorkspaceApi(new CustomerAuth(db, { origin }), new WorkspaceService(db, mode));
    const disabled = await disabledApi(request("assist", "POST", { action: "BRIEF", campaign }));
    assert.equal(disabled.status, 503); assert.equal((await disabled.json()).code, "ASSISTANT_UNAVAILABLE");
  }
  const before = await db.workspaceCampaign.count();
  const first = await mockApi(request("assist", "POST", { action: "BRIEF", campaign }));
  assert.equal(first.status, 200); assert.equal(first.headers.get("cache-control"), "no-store");
  const result = await first.json();
  assert.equal(result.mode, "mock"); assert.match(result.message, /simulated/);
  assert.ok(result.brief.includes(campaign.brief)); assert.ok(result.brief.includes(campaign.audience));
  assert.deepEqual(await (await mockApi(request("assist", "POST", { action: "BRIEF", campaign }))).json(), result);
  assert.equal(await db.workspaceCampaign.count(), before);
});

test("mock creative suggestions follow selected channels, preserve supplied facts and validate request bounds", async () => {
  const mockApi = createWorkspaceApi(new CustomerAuth(db, { origin }), new WorkspaceService(db, "mock"));
  const campaign = { type: "SOCIAL", name: "Studio open day", websiteUrl: "https://example.test", brief: "Visit the studio on Saturday to see our ceramic collection.", goal: "awareness", audience: "Local visitors", platforms: ["YOUTUBE", "FACEBOOK", "INSTAGRAM", "TIKTOK", "LINKEDIN", "X"] };
  const response = await mockApi(request("assist", "POST", { action: "CREATIVES", campaign }));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.creatives.map((creative: { platform: string }) => creative.platform), campaign.platforms);
  assert.deepEqual(result.creatives.map((creative: { format: string }) => creative.format), ["SHORT_VIDEO", "IMAGE", "SHORT_VIDEO", "SHORT_VIDEO", "TEXT", "TEXT"]);
  for (const creative of result.creatives) { assert.equal(creative.body, campaign.brief); assert.equal(creative.title, campaign.name); }
  for (const [type, platforms, formats] of [["ADS", ["GOOGLE", "META"], ["SEARCH", "IMAGE"]], ["EMAIL", ["EMAIL"], ["EMAIL"]], ["BLOG", ["BLOG"], ["ARTICLE"]]] as const) {
    const generated = await mockApi(request("assist", "POST", { action: "CREATIVES", campaign: { ...campaign, type, platforms } }));
    assert.equal(generated.status, 200);
    assert.deepEqual((await generated.json()).creatives.map((creative: { format: string }) => creative.format), formats);
  }
  for (const changes of [{ brief: "" }, { brief: "x".repeat(10001) }, { type: "ADS", platforms: ["YOUTUBE"] }, { websiteUrl: "javascript:alert(1)" }, { platforms: [] }, { ownerId: bob.id }, { plan: { text: "x".repeat(24001) } }]) {
    assert.equal((await mockApi(request("assist", "POST", { action: "CREATIVES", campaign: { ...campaign, ...changes } }))).status, 400);
  }
  assert.equal((await mockApi(request("assist", "POST", { action: "PUBLISH", campaign }))).status, 400);
  assert.equal((await mockApi(request("assist", "POST", { action: "BRIEF", campaign, customerId: bob.id }))).status, 400);
});
