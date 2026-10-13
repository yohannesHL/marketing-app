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
import { applyConnectionMigrations } from "../support/test-database";
import { LinkedInSocialProvider, linkedinSocialRegistration } from "../../apps/web/src/server/social/providers/linkedin";
import { LINKEDIN_MEMBER_SCOPES } from "../../apps/web/src/server/providers/linkedin";
import { SocialProviderFailure, SocialProviderRegistry, type SocialProviderContext, type SocialProviderCall, type SocialProgress } from "../../apps/web/src/server/social/types";
import { startMockoon } from "../support/mockoon";
let mock: Awaited<ReturnType<typeof startMockoon>>;
let db: PrismaClient, directory: string;
before(async () => {
  mock = await startMockoon("tests/mockoon/linkedin.json"); directory = await mkdtemp(join(tmpdir(), "linkedin-social-provider-"));
  const url = `file:${join(directory, "test.db")}`; const sql = createClient({ url }); await applyConnectionMigrations(sql); sql.close();
  db = new PrismaClient({ adapter: new PrismaLibSql({ url }) });
});
after(async () => { await mock?.stop(); await db?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });
const config = () => ({ clientId: "li-client", clientSecret: "fixture-li-secret", redirectUri: "https://launchpad.test/api/connections/linkedin/callback",
  scopes: [...LINKEDIN_MEMBER_SCOPES, "r_member_social"], mockoonEnabled: true, mockoonBaseUrl: mock.origin,
  requestTimeoutMs: 1000, now: () => new Date("2026-10-13T12:00:00Z") });
function harness(body = "Text fixture", format: "TEXT" | "IMAGE" | "SHORT_VIDEO" = "TEXT", patch: Partial<SocialProviderCall> = {}) {
  const saved: SocialProgress[] = [], events: string[] = [];
  const call: SocialProviderCall = { mode: "mock", accessToken: "member-token", authorizationId: "authorization-a", providerUserId: "member-a", authorizationGeneration: 1,
    verifyCurrent: async () => { events.push("guard"); }, destination: { externalId: "urn:li:person:member-a", kind: "LINKEDIN_MEMBER", metadata: {} },
    media: format === "TEXT" ? [] : [{ id: format === "IMAGE" ? "image-fixture" : "video-fixture", url: `${mock.origin}/api/social/media/${format === "IMAGE" ? "image-fixture" : "video-fixture"}/content?expires=1791979200&signature=${"a".repeat(64)}`,
      mime: format === "IMAGE" ? "image/png" : "video/mp4", bytes: format === "IMAGE" ? 8 : 80000, width: 1080, height: 1920, durationMs: format === "IMAGE" ? null : 60000 }], ...patch };
  const context: SocialProviderContext = { deliveryId: `delivery-${body}`, revisionId: `revision-${body}`,
    content: { title: "", body, format, providerOptions: { visibility: body === "Text fixture" ? "CONNECTIONS" : "PUBLIC" } },
    rpc: async (phase, invoke) => { events.push(phase); return invoke(call); }, checkpoint: async (p) => { events.push("checkpoint"); saved.push(structuredClone(p)); } };
  return { context, call, saved, events, provider: new LinkedInSocialProvider(config(), { mediaOrigin: mock.origin }) };
}
test("LinkedIn adapter confirms text/member and organization authors only after lifecycle readback", async () => {
  for (const organization of [false, true]) {
    const h = organization ? harness("Organization fixture", "TEXT", { accessToken: "org-token", destination: { externalId: "urn:li:organization:123", kind: "LINKEDIN_ORGANIZATION", metadata: {} } }) : harness();
    await h.provider.validate(h.context); const prepared = await h.provider.prepare(h.context, {});
    assert.equal(h.events.includes("PUBLISH"), false);
    const result = await h.provider.publish(h.context, prepared);
    assert.equal(result.externalId, organization ? "urn:li:share:201" : "urn:li:share:101");
    assert.equal(h.events.filter((e) => e === "PUBLISH").length, 1);
    assert.equal(h.saved.at(-1)?.postUrn, result.externalId);
    assert.equal((await h.provider.status(h.context, h.saved.at(-1)!)).status, "PUBLISHED");
    assert.doesNotMatch(JSON.stringify(h.saved), /member-token|org-token|signature=/);
  }
});
test("image and video checkpoints precede upload and preserve the receipt before confirmation", async () => {
  for (const organization of [false, true]) for (const format of ["IMAGE", "SHORT_VIDEO"] as const) {
    const h = organization ? harness(format === "IMAGE" ? "Organization image fixture" : "Organization video fixture", format,
      { accessToken: "org-token", destination: { externalId: "urn:li:organization:123", kind: "LINKEDIN_ORGANIZATION", metadata: {} } }) :
      harness(format === "IMAGE" ? "Image fixture" : "Video fixture", format);
    await h.provider.validate(h.context); const prepared = await h.provider.prepare(h.context, {});
    const plan = h.saved.findIndex((p) => p.plan !== undefined);
    assert.ok(plan >= 0); assert.equal(h.saved[plan].uploaded, false);
    assert.equal(h.events.includes("PUBLISH"), false);
    assert.equal((await h.provider.publish(h.context, prepared)).externalId, organization ? (format === "IMAGE" ? "urn:li:share:205" : "urn:li:share:206") : (format === "IMAGE" ? "urn:li:share:105" : "urn:li:share:106"));
    assert.equal(h.saved.at(-1)?.lifecycleState, "PUBLISHED");
    assert.doesNotMatch(JSON.stringify(h.saved), /member-token|signature=/);
  }
});
test("accepted pending and known failed posts retain author-owned receipts without another create", async () => {
  for (const failed of [false, true]) {
    const h = harness(failed ? "Failed fixture" : "Pending fixture");
    const prepared = await h.provider.prepare(h.context, {});
    await assert.rejects(h.provider.publish(h.context, prepared), (e: unknown) => e instanceof SocialProviderFailure && !e.definitive);
    const p = h.saved.at(-1)!;
    assert.deepEqual(await h.provider.status(h.context, p), failed ? { status: "FAILED", result: { externalId: "urn:li:share:103" } } : { status: "PENDING" });
    await assert.rejects(h.provider.publish(h.context, p), (e: unknown) => e instanceof SocialProviderFailure && !e.definitive);
    assert.equal(h.events.filter((e) => e === "PUBLISH").length, 1);
  }
});
test("ambiguous creates never retry; an authoritative 429 rejects inside the PUBLISH boundary", async () => {
  for (const body of ["missing-id fixture", "timeout fixture", "quota fixture"]) {
    const h = harness(body), p = await h.provider.prepare(h.context, {});
    await assert.rejects(h.provider.publish(h.context, p), (e: unknown) => e instanceof SocialProviderFailure &&
      (body === "quota fixture" ? e.kind === "RATE_LIMIT" && e.definitive : !e.definitive));
    const stored = h.saved.at(-1)!;
    if (body !== "quota fixture") {
      assert.equal(stored.publishAttempted, true);
      assert.deepEqual(await h.provider.status(h.context, stored), { status: "UNKNOWN" });
      await assert.rejects(h.provider.publish(h.context, stored), (e: unknown) => e instanceof SocialProviderFailure && !e.definitive);
      assert.equal(h.events.filter((e) => e === "PUBLISH").length, 1);
    } else assert.equal(stored.publishAttempted, false);
  }
});
test("binding, read capability, role, media and guard failures stop before publication", async () => {
  const mode = harness("Text fixture", "TEXT", { mode: "live" }); await assert.rejects(mode.provider.validate(mode.context), { code: "CONNECTION_MODE_MISMATCH" });
  const read = harness("Text fixture", "TEXT", { accessToken: "selfserve-token" }); await assert.rejects(read.provider.validate(read.context), { code: "READ_CAPABILITY_REQUIRED" });
  const dsc = harness("Organization fixture", "TEXT", { accessToken: "dsc-token", destination: { externalId: "urn:li:organization:123", kind: "LINKEDIN_ORGANIZATION", metadata: {} } });
  await assert.rejects(dsc.provider.validate(dsc.context), { code: "ORGANIZATION_ROLE_REQUIRED" });
  const h = harness(), p = await h.provider.prepare(h.context, {});
  await assert.rejects(h.provider.status(h.context, { ...p, publishAttempted: true, postUrn: "urn:li:share:199" }), { code: "AUTHOR_MISMATCH" });
  await assert.rejects(h.provider.status(h.context, { ...p, authorUrn: "urn:li:person:member-b" }), { code: "INVALID_PROVIDER_PROGRESS" });
  h.call.authorizationGeneration = 2; await assert.rejects(h.provider.publish(h.context, p), { code: "INVALID_PROVIDER_PROGRESS" });
  const untrusted = harness("Image fixture", "IMAGE"); untrusted.call.media[0].url = "https://attacker.test/private";
  await assert.rejects(untrusted.provider.prepare(untrusted.context, {}), { code: "MEDIA_UNAVAILABLE" }); assert.equal(untrusted.events.includes("UPLOAD"), false);
  const stale = harness(); const initial = await stale.provider.prepare(stale.context, {}); let checks = 0;
  const error = Object.assign(new Error("Stale authorization."), { code: "STALE_CREDENTIALS" });
  stale.call.verifyCurrent = async () => { if (++checks > 1) throw error; };
  await assert.rejects(stale.provider.publish(stale.context, initial), (e: unknown) => e === error);
  assert.equal(stale.saved.at(-1)?.postUrn, undefined);
  assert.deepEqual(linkedinSocialRegistration(config(), { mediaOrigin: mock.origin }, "LINKEDIN_MEMBER").requiredScopes, [...LINKEDIN_MEMBER_SCOPES, "r_member_social"]);
});

test("interrupted image upload resumes its saved asset before publication and rejects expired or foreign progress", async () => {
  const h = harness("Image fixture", "IMAGE"); const checkpoint = h.context.checkpoint;
  h.context.checkpoint = async (p) => { await checkpoint(p); throw new Error("Simulated interruption before upload"); };
  await assert.rejects(h.provider.prepare(h.context, {}), /Simulated interruption/);
  const p = h.saved.at(-1)!; assert.ok(p.plan); assert.equal(p.uploaded, false);
  const restarted = harness("Image fixture", "IMAGE");
  const loaded = await restarted.provider.prepare(restarted.context, p);
  assert.equal(restarted.events.filter((e) => e === "UPLOAD").length, 1);
  assert.equal((await restarted.provider.publish(restarted.context, loaded)).externalId, "urn:li:share:105");
  const fresh = harness("Image fixture", "IMAGE");
  const plan = p.plan as Record<string, unknown>;
  await assert.rejects(fresh.provider.prepare(fresh.context, { ...p, plan: { ...plan, mediaUrn: "urn:li:image:waiting", expiresAt: 1 } }),
    (e: unknown) => e instanceof SocialProviderFailure && e.definitive);
  await assert.rejects(fresh.provider.prepare(fresh.context, { ...p, plan: { ...plan, ownerUrn: "urn:li:person:member-b" } }), { code: "INVALID_PROVIDER_PROGRESS" });
});

test("owned failed media reconciliation keeps the asset ID with no public link or submission", async () => {
  const h = harness("Image fixture", "IMAGE"), p = await h.provider.prepare(h.context, {});
  assert.deepEqual(await h.provider.status(h.context, { ...p, plan: { ...(p.plan as object), mediaUrn: "urn:li:image:failed" } }),
    { status: "FAILED", result: { externalId: "urn:li:image:failed" } });
  assert.equal(h.events.includes("PUBLISH"), false);
});

test("real worker preserves accepted receipts for pending, failed, quota and timed-out processing without another create", async () => {
  const now = () => new Date("2026-10-13T12:00:00Z"), origin = "https://launchpad.test";
  const auth = new CustomerAuth(db, { origin }, now), vault = new CredentialVault({ test: Buffer.alloc(32, 71).toString("base64") }, "test");
  const connections = new CustomerConnections(db, auth, vault, now);
  for (const scenario of ["worker-pending", "worker-failed", "worker-rate", "worker-timeout"]) {
    const email = `linkedin-${scenario}@example.test`, password = "isolated LinkedIn delivery customer password";
    await auth.provisionCustomer({ name: scenario, email, password }); const login = await auth.login(email, password);
    const principal = await auth.requireSession(new Request(origin, { headers: { cookie: login.cookie.split(";")[0] } }));
    const scopes = [...LINKEDIN_MEMBER_SCOPES, "r_member_social"];
    const oauth = { provider: "LINKEDIN" as const, capability: "SOCIAL" as const, redirectUri: config().redirectUri, scopes, pkce: false };
    const start = await connections.beginOAuth(principal, oauth);
    const grant = await connections.completeAuthorization(principal, start.state, oauth, { providerUserId: "member-a", accessToken: "member-token",
      scopes, connectionMode: "MOCK", expiresAt: new Date("2026-10-14T12:00:00Z") });
    const destination = await connections.registerDestination(principal, grant.id, { externalId: "urn:li:person:member-a", name: "Synthetic member", kind: "LINKEDIN_MEMBER" });
    await db.connectionDestination.update({ where: { id: destination.id }, data: { selected: true, metadata: { canWrite: "ALLOWED" }, lastCheckedAt: now() } });
    const providers = new SocialProviderRegistry(); providers.register(linkedinSocialRegistration(config(), { mediaOrigin: mock.origin }, "LINKEDIN_MEMBER"));
    const configuration = { mode: "mock" as const, writesEnabled: true, approvedProviders: ["LINKEDIN:LINKEDIN_MEMBER"] };
    const service = new SocialPostService(db, auth, configuration, providers, now);
    const post = await service.create(principal, { title: "LinkedIn worker receipt", body: scenario, mediaIds: [],
      variants: [{ destinationId: destination.id, format: "TEXT", providerOptions: { visibility: "PUBLIC" } }] });
    await service.approve(principal, post.id, post.revision!.id, [destination.id]);
    const queued = await service.enqueue(principal, post.id, { revisionId: post.revision!.id, destinationIds: [destination.id], enqueueId: scenario,
      dueAt: now().toISOString(), timeZone: "UTC" });
    const worker = () => new SocialDeliveryWorker(db, vault, providers, configuration, undefined, now);
    assert.equal((await worker().runOnce())?.status, "UNCERTAIN"); const id = queued.deliveries[0].id;
    let delivery = await db.socialDelivery.findUniqueOrThrow({ where: { id } }); assert.ok(delivery.publishStartedAt); assert.equal(delivery.phase, "PUBLISH");
    const encrypted = await db.socialDeliveryProgress.findUniqueOrThrow({ where: { deliveryId: id } });
    assert.doesNotMatch(encrypted.encryptedState, /urn:li:share|member-token/);
    const progress = JSON.parse(vault.decrypt(encrypted.encryptedState, `social-progress-v1:${id}`));
    assert.ok(progress.postUrn); assert.equal(progress.publishAttempted, true);
    assert.equal(await worker().runOnce(), null);
    assert.equal((await worker().reconcileOnce(id))?.status, scenario === "worker-failed" ? "FAILED" : "UNCERTAIN");
    delivery = await db.socialDelivery.findUniqueOrThrow({ where: { id } }); assert.ok(delivery.publishStartedAt);
    if (scenario === "worker-failed") { assert.equal(delivery.errorCode, "PROVIDER_PROCESSING_FAILED"); assert.equal(delivery.externalId, progress.postUrn); assert.equal(delivery.publishUrl, null); }
    assert.equal(await worker().runOnce(), null);
    await assert.rejects(service.retry(principal, post.id, [id]), { code: "RECONCILIATION_REQUIRED" });
    assert.deepEqual(await (await fetch(`${mock.origin}/fixture/posts-count/${scenario}`)).json(), { count: 1 });
    assert.doesNotMatch(JSON.stringify(await service.get(principal, post.id)), /member-token|fixture-li-secret|private-provider-secret|uploadUrl|partIds/);
  }
});

test("saved video ETags resume finalization without uploading accepted parts again", async () => {
  const h = harness("Video fixture", "SHORT_VIDEO"), checkpoint = h.context.checkpoint;
  h.context.checkpoint = async (p) => { await checkpoint(p); if ((p.partIds as unknown[]).length && !p.finalizeStarted) throw new Error("Simulated interruption after part receipt"); };
  await assert.rejects(h.provider.prepare(h.context, {}), /Simulated interruption after part receipt/);
  const p = h.saved.at(-1)!; assert.deepEqual(p.partIds, ["etag-fixture-Member"]);
  const restarted = harness("Video fixture", "SHORT_VIDEO"), loaded = await restarted.provider.prepare(restarted.context, p);
  assert.equal(restarted.events.filter((e) => e === "UPLOAD").length, 1);
  assert.equal((await restarted.provider.publish(restarted.context, loaded)).externalId, "urn:li:share:106");
  const unknownFinalize = { ...p, finalizeStarted: true, plan: { ...(p.plan as object), mediaUrn: "urn:li:video:waiting" } };
  const conservative = harness("Video fixture", "SHORT_VIDEO");
  await assert.rejects(conservative.provider.prepare(conservative.context, unknownFinalize), (e: unknown) => e instanceof SocialProviderFailure && e.definitive);
  assert.equal(unknownFinalize.finalizeStarted, true);
  assert.equal(conservative.events.includes("UPLOAD"), false); assert.equal(conservative.events.includes("PUBLISH"), false);
});

test("role loss or token expiry after preparation never submits under another author", async () => {
  const org = harness("Organization fixture", "TEXT", { accessToken: "org-token", destination: { externalId: "urn:li:organization:123", kind: "LINKEDIN_ORGANIZATION", metadata: {} } });
  await org.provider.validate(org.context); const p = await org.provider.prepare(org.context, {}); org.call.accessToken = "revoked-role-token";
  await assert.rejects(org.provider.publish(org.context, p), { code: "ORGANIZATION_ROLE_REQUIRED" });
  assert.equal(org.saved.at(-1)?.postUrn, undefined);
  const member = harness(); const ready = await member.provider.prepare(member.context, {}); member.call.accessToken = "expired-token";
  await assert.rejects(member.provider.publish(member.context, ready), { code: "RECONNECT_REQUIRED" });
  assert.equal(member.saved.at(-1)?.postUrn, undefined);
  assert.equal(org.call.destination.externalId, "urn:li:organization:123"); assert.equal(member.call.destination.externalId, "urn:li:person:member-a");
});

import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

type ProcessingScenario = "processing" | "failed" | "prepare-rate" | "post-rate";
/** Isolated real HTTP transitions; duplicate counters prove recovery reads the saved asset. */
async function processingFixture(scenario: ProcessingScenario) {
  const folder = await mkdtemp(join(tmpdir(), "linkedin-processing-http-"));
  const fixture = JSON.parse(await readFile("tests/mockoon/linkedin.json", "utf8"));
  const health = fixture.routes.find((route: { endpoint: string }) => route.endpoint === "health");
  const rule = (name: string, value = "1") => ({ target: "global_var", modifier: name, value, operator: "equals", invert: false });
  const countMutation = (route: typeof health, response: typeof health.responses[number], name: string) => {
    const duplicate = structuredClone(response); duplicate.uuid = randomUUID();
    duplicate.disableTemplating = false; response.disableTemplating = false;
    duplicate.rules.push({ ...rule(name, "^[12]$"), operator: "regex" }); duplicate.body = `{{setGlobalVar '${name}' '2'}}${response.body}`;
    response.body = `{{setGlobalVar '${name}' '1'}}${response.body}`;
    route.responses.unshift(duplicate);
  };
  for (const route of fixture.routes) {
    for (const response of [...route.responses]) {
      if (route.endpoint === "rest/videos" && response.body.includes("video-fixtureMember")) {
        countMutation(route, response, response.body.includes("WAITING_UPLOAD") ? "review-init" : "review-finalize");
      } else if (route.endpoint === "dms-uploads/fixtureMember/video") {
        countMutation(route, response, "review-upload");
      } else if (route.endpoint === "rest/posts" && response.rules.some((r: { modifier: string; value: string }) =>
        r.modifier === "commentary" && r.value === "Video fixture")) {
        countMutation(route, response, "review-post");
      }
      if (route.endpoint === "rest/videos/:urn" && response.body.includes('"id": "urn:li:video:fixtureMember"')) {
        const body = JSON.parse(response.body);
        body.status = scenario === "failed" ? "PROCESSING_FAILED" : scenario === "processing"
          ? "{{#if (getGlobalVar 'review-ready' '' false)}}AVAILABLE{{else}}PROCESSING{{/if}}" : "AVAILABLE";
        response.body = JSON.stringify(body);
        if (scenario === "prepare-rate") {
          const limited = structuredClone(response); limited.uuid = randomUUID(); limited.statusCode = 429;
          limited.body = JSON.stringify({ message: "private processing fixture error" });
          limited.rules.push({ ...rule("review-ready", "true"), invert: true }); route.responses.unshift(limited);
        }
      }
      if (scenario === "post-rate" && route.endpoint === "rest/posts/:urn" && response.body.includes('"id": "urn:li:share:106"')) {
        const limited = structuredClone(response); limited.uuid = randomUUID(); limited.statusCode = 429;
        limited.body = JSON.stringify({ message: "private receipt fixture error" });
        limited.rules.push({ ...rule("review-ready", "true"), invert: true }); route.responses.unshift(limited);
      }
    }
  }
  const endpoint = (name: string, method: string, body: string) => {
    const route = structuredClone(health); route.uuid = randomUUID(); route.endpoint = name; route.method = method;
    route.responses = [structuredClone(health.responses[0])]; route.responses[0].uuid = randomUUID(); route.responses[0].body = body;
    route.responses[0].disableTemplating = false;
    return route;
  };
  fixture.routes.push(endpoint("fixture/review/ready", "post", "{{setGlobalVar 'review-ready' 'true'}}{}"));
  fixture.routes.push(endpoint("fixture/review/counts", "get",
    `{"init":{{getGlobalVar 'review-init' '' '0'}},"upload":{{getGlobalVar 'review-upload' '' '0'}},"finalize":{{getGlobalVar 'review-finalize' '' '0'}},"post":{{getGlobalVar 'review-post' '' '0'}} }`));
  const file = join(folder, "fixture.json"); await writeFile(file, JSON.stringify(fixture));
  const server = await startMockoon(file);
  return { ...server, counts: async () => (await fetch(`${server.origin}/fixture/review/counts`)).json(),
    ready: async () => { assert.equal((await fetch(`${server.origin}/fixture/review/ready`, { method: "POST" })).status, 200); },
    close: async () => { await server.stop(); await rm(folder, { recursive: true, force: true }); } };
}

async function processingWorker(scenario: ProcessingScenario) {
  const server = await processingFixture(scenario), folder = await mkdtemp(join(tmpdir(), "linkedin-processing-db-"));
  const url = `file:${join(folder, "test.sqlite")}`, sql = createClient({ url }); await applyConnectionMigrations(sql); sql.close();
  const database = new PrismaClient({ adapter: new PrismaLibSql({ url }) });
  let clock = new Date("2026-10-13T12:00:00Z"); const now = () => clock, origin = "https://launchpad.test";
  const auth = new CustomerAuth(database, { origin }, now);
  const vault = new CredentialVault({ test: Buffer.alloc(32, 72).toString("base64") }, "test");
  const connections = new CustomerConnections(database, auth, vault, now), password = "isolated processing fixture customer password";
  await auth.provisionCustomer({ name: scenario, email: "processing@example.test", password });
  const login = await auth.login("processing@example.test", password);
  const principal = await auth.requireSession(new Request(origin, { headers: { cookie: login.cookie.split(";")[0] } }));
  const providerConfig = { ...config(), mockoonBaseUrl: server.origin, now };
  const scopes = [...LINKEDIN_MEMBER_SCOPES, "r_member_social"];
  const oauth = { provider: "LINKEDIN" as const, capability: "SOCIAL" as const, scopes, pkce: false, redirectUri: providerConfig.redirectUri };
  const start = await connections.beginOAuth(principal, oauth);
  const grant = await connections.completeAuthorization(principal, start.state, oauth, {
    providerUserId: "member-a", accessToken: "member-token", scopes, connectionMode: "MOCK", expiresAt: new Date("2026-10-14T12:00:00Z") });
  const destination = await connections.registerDestination(principal, grant.id, {
    kind: "LINKEDIN_MEMBER", externalId: "urn:li:person:member-a", name: "Synthetic member" });
  await database.connectionDestination.update({ where: { id: destination.id }, data: {
    selected: true, metadata: { canWrite: "ALLOWED" }, lastCheckedAt: now() } });
  // Trusted fixture metadata; actual decoder/ingestion validation is covered by media-store tests.
  const asset = await database.socialMediaAsset.create({ data: { id: "video-fixture", ownerId: principal.userId,
    storageKey: "processing-fixture", digest: "a".repeat(64), mime: "video/mp4", type: "VIDEO", bytes: 80000,
    width: 1080, height: 1920, durationMs: 60000, status: "AVAILABLE", verifiedAt: now() } });
  const registry = new SocialProviderRegistry(); registry.register(linkedinSocialRegistration(providerConfig, { mediaOrigin: server.origin }, "LINKEDIN_MEMBER"));
  const configuration = { mode: "mock" as const, writesEnabled: true, approvedProviders: ["LINKEDIN:LINKEDIN_MEMBER"], maxAttempts: 3 };
  const service = new SocialPostService(database, auth, configuration, registry, now);
  const post = await service.create(principal, { title: "Processing review", body: "Video fixture", mediaIds: [asset.id],
    variants: [{ destinationId: destination.id, format: "SHORT_VIDEO", providerOptions: { visibility: "PUBLIC" } }] });
  await service.approve(principal, post.id, post.revision!.id, [destination.id]);
  const queued = await service.enqueue(principal, post.id, { revisionId: post.revision!.id, destinationIds: [destination.id],
    enqueueId: "processing-regression", dueAt: now().toISOString(), timeZone: "UTC" });
  const id = queued.deliveries[0].id;
  const worker = () => new SocialDeliveryWorker(database, vault, registry, configuration,
    async () => [{ id: asset.id, url: `${server.origin}/api/social/media/video-fixture/content?expires=1791979200&signature=${"a".repeat(64)}` }], now);
  return { server, database, service, principal, post, id, worker,
    advance: () => { clock = new Date(clock.getTime() + 10000); },
    progress: async () => { const row = await database.socialDeliveryProgress.findUniqueOrThrow({ where: { deliveryId: id } });
      return JSON.parse(vault.decrypt(row.encryptedState, `social-progress-v1:${id}`)); },
    close: async () => { await database.$disconnect(); await server.close(); await rm(folder, { recursive: true, force: true }); } };
}

test("normal asynchronous media processing resumes its saved upload and publishes once after AVAILABLE", async () => {
  const q = await processingWorker("processing");
  try {
    assert.equal((await q.worker().runOnce())?.status, "RETRY_WAIT"); assert.equal(await q.worker().runOnce(), null);
    const saved = await q.progress(); assert.equal(saved.plan.mediaUrn, "urn:li:video:fixtureMember");
    assert.deepEqual(saved.partIds, ["etag-fixture-Member"]); assert.equal(saved.uploaded, true); assert.equal(saved.publishAttempted, false);
    assert.deepEqual(await q.server.counts(), { init: 1, upload: 1, finalize: 1, post: 0 });
    await q.server.ready(); q.advance(); assert.equal((await q.worker().runOnce())?.status, "SUCCEEDED");
    assert.deepEqual(await q.server.counts(), { init: 1, upload: 1, finalize: 1, post: 1 });
  } finally { await q.close(); }
});

test("known failed asset processing is terminal and retains its media receipt without new initialization or publication", async () => {
  const q = await processingWorker("failed");
  try {
    assert.equal((await q.worker().runOnce())?.status, "BLOCKED");
    assert.equal(await q.worker().runOnce(), null); q.advance(); assert.equal(await q.worker().reconcileOnce(q.id), null);
    const saved = await q.progress(); assert.equal(saved.plan.mediaUrn, "urn:li:video:fixtureMember");
    assert.deepEqual(saved.partIds, ["etag-fixture-Member"]); assert.equal(saved.publishAttempted, false);
    assert.deepEqual(await q.server.counts(), { init: 1, upload: 1, finalize: 1, post: 0 });
  } finally { await q.close(); }
});

test("PREPARE media GET429 retries only reads of the saved plan within the worker attempt budget", async () => {
  const q = await processingWorker("prepare-rate");
  try {
    assert.equal((await q.worker().runOnce())?.status, "RETRY_WAIT"); assert.equal(await q.worker().runOnce(), null);
    q.advance(); assert.equal((await q.worker().runOnce())?.status, "RETRY_WAIT");
    q.advance(); assert.equal((await q.worker().runOnce())?.status, "FAILED"); q.advance(); assert.equal(await q.worker().runOnce(), null);
    assert.equal((await q.progress()).plan.mediaUrn, "urn:li:video:fixtureMember");
    assert.deepEqual(await q.server.counts(), { init: 1, upload: 1, finalize: 1, post: 0 });
  } finally { await q.close(); }
});

test("post-create GET429 preserves publication uncertainty and reconciles the stored post without another create", async () => {
  const q = await processingWorker("post-rate");
  try {
    assert.equal((await q.worker().runOnce())?.status, "UNCERTAIN"); assert.equal(await q.worker().runOnce(), null);
    const saved = await q.progress(); assert.equal(saved.postUrn, "urn:li:share:106"); assert.equal(saved.publishAttempted, true);
    q.advance(); assert.equal((await q.worker().reconcileOnce(q.id))?.status, "UNCERTAIN");
    await assert.rejects(q.service.retry(q.principal, q.post.id, [q.id]), { code: "RECONCILIATION_REQUIRED" });
    await q.server.ready(); q.advance(); assert.equal((await q.worker().reconcileOnce(q.id))?.status, "SUCCEEDED");
    assert.deepEqual(await q.server.counts(), { init: 1, upload: 1, finalize: 1, post: 1 });
  } finally { await q.close(); }
});
