import assert from "node:assert/strict";
import { test } from "node:test";
import { Prisma } from "../../apps/web/src/generated/prisma/client";
import { SocialDeliveryWorker } from "../../apps/web/src/server/social/deliveryWorker";
import { SocialApiBudget } from "../../apps/web/src/server/social/apiBudget";
import { socialAllPlatformFixture } from "../support/social-all-platform-fixture";

const timeout = () => new Prisma.PrismaClientKnownRequestError("Worker transaction timed out", { code: "P1008", clientVersion: "7.5.0" });
async function queued() {
  const q = await socialAllPlatformFixture();
  try {
    const owner = await q.customer("claim-timeout-owner"), grant = await owner.connect("x"), image = await owner.upload("png");
    const destination = grant.destinations.find((row: any) => row.selected)!;
    const read = async (response: Response, status = 200) => {
      assert.equal(response.status, status); return response.json();
    };
    const post = await read(await owner.api("/api/social/posts", { title: "Reviewed timeout fixture", body: "Fixture image", mediaIds: [image.id],
      variants: [{ destinationId: destination.id, format: "IMAGE", mediaIds: [image.id], providerOptions: { madeWithAi: false, paidPartnership: false, maxApiCostMicros: 1_000_000 } }] }), 201);
    await read(await owner.api(`/api/social/posts/${post.id}/approve`, { revisionId: post.revision.id, destinationIds: [destination.id] }));
    const enqueued = await read(await owner.api(`/api/social/posts/${post.id}/enqueue`, { revisionId: post.revision.id, destinationIds: [destination.id],
      enqueueId: "claim-timeout-reviewed", dueAt: q.now().toISOString(), timeZone: "UTC" }));
    return { q, owner, post, deliveryId: enqueued.deliveries[0].id };
  } catch (error) { await q.close(); throw error; }
}
type Setup = Awaited<ReturnType<typeof queued>>;
function worker(setup: Setup, intercept: (invoke: () => Promise<any>, call: number) => Promise<any>) {
  let calls = 0;
  const db = new Proxy(setup.q.db, { get(target, property) {
    if (property === "$transaction") return (...args: any[]) => intercept(() => (target.$transaction as any)(...args), ++calls);
    const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  return { calls: () => calls, instance: new SocialDeliveryWorker(db, setup.q.vault, setup.q.registry, { ...setup.q.config, leaseMs: 1000 },
    request => setup.q.media.resolve(request), setup.q.now, undefined, new SocialApiBudget(setup.q.db, setup.q.xOwnerPolicies, setup.q.now)) };
}
async function noDeliveryHttp(setup: Setup) {
  // Every X SDK read/write must reserve its delivery-scoped allocation before
  // HTTP. Connection OAuth allocations have no deliveryId and are excluded.
  assert.equal(await setup.q.db.socialApiCostReservation.count({ where: { deliveryId: setup.deliveryId } }), 0);
  await publicationCounts(setup, "0");
}
async function publicationCounts(setup: Setup, expected: "0" | "1") {
  const response = await fetch(`${setup.q.mocks.x.origin}/qa/counts`); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { "qa-create": expected, "qa-image-upload": expected, "qa-unknown-submit": "0" });
}

test("known claim timeout before its transaction callback retries locally and publishes the actual reviewed X post once", { timeout: 45_000 }, async () => {
  const setup = await queued();
  try {
    const candidate = worker(setup, async (invoke, call) => { if (call === 1) throw timeout(); return invoke(); });
    assert.equal((await candidate.instance.runOnce())?.status, "SUCCEEDED");
    assert.equal((await setup.q.db.socialDelivery.findUniqueOrThrow({ where: { id: setup.deliveryId } })).attempts, 1);
    await publicationCounts(setup, "1"); assert.equal(await candidate.instance.runOnce(), null); await publicationCounts(setup, "1");
  } finally { await setup.q.close(); }
});

test("four exhausted claim timeouts send no provider HTTP and a later poll can publish exactly once", { timeout: 45_000 }, async () => {
  const setup = await queued();
  try {
    const candidate = worker(setup, async (invoke, call) => { if (call <= 4) throw timeout(); return invoke(); });
    assert.equal(await candidate.instance.runOnce(), null); assert.equal(candidate.calls(), 4);
    const unchanged = await setup.q.db.socialDelivery.findUniqueOrThrow({ where: { id: setup.deliveryId } });
    assert.equal(unchanged.status, "QUEUED"); assert.equal(unchanged.attempts, 0); assert.equal(unchanged.publishStartedAt, null);
    await noDeliveryHttp(setup);
    assert.equal((await candidate.instance.runOnce())?.status, "SUCCEEDED"); await publicationCounts(setup, "1");
  } finally { await setup.q.close(); }
});

test("timeout reported after a real committed lease does not execute or re-create it before safe lease-expiry recovery", { timeout: 45_000 }, async () => {
  const setup = await queued();
  try {
    const candidate = worker(setup, async (invoke, call) => { const result = await invoke(); if (call === 1) throw timeout(); return result; });
    assert.equal(await candidate.instance.runOnce(), null);
    const claimed = await setup.q.db.socialDelivery.findUniqueOrThrow({ where: { id: setup.deliveryId } });
    assert.equal(claimed.status, "LEASED"); assert.equal(claimed.phase, "PREPARE"); assert.equal(claimed.attempts, 1);
    assert.equal(claimed.publishStartedAt, null); assert.ok(claimed.leaseTokenHash); await noDeliveryHttp(setup);
    assert.equal(await candidate.instance.runOnce(), null); await noDeliveryHttp(setup);
    setup.q.advance(1001);
    assert.equal((await candidate.instance.runOnce())?.status, "SUCCEEDED");
    const recovered = await setup.q.db.socialDelivery.findUniqueOrThrow({ where: { id: setup.deliveryId } });
    assert.equal(recovered.attempts, 2); await publicationCounts(setup, "1");
    assert.equal(await candidate.instance.runOnce(), null); await publicationCounts(setup, "1");
  } finally { await setup.q.close(); }
});

test("an unknown claim transaction error still rejects without provider submission or lease mutation", { timeout: 45_000 }, async () => {
  const setup = await queued();
  try {
    const unknown = new Error("Unknown storage failure"), candidate = worker(setup, async () => { throw unknown; });
    await assert.rejects(candidate.instance.runOnce(), error => error === unknown); assert.equal(candidate.calls(), 1);
    const untouched = await setup.q.db.socialDelivery.findUniqueOrThrow({ where: { id: setup.deliveryId } });
    assert.equal(untouched.status, "QUEUED"); assert.equal(untouched.attempts, 0); await noDeliveryHttp(setup);
  } finally { await setup.q.close(); }
});


test("structured libSQL raw-query BUSY and BUSY_SNAPSHOT errors retry locally without relying on generic message text", { timeout: 45_000 }, async () => {
  const setup = await queued();
  try {
    const candidate = worker(setup, async (invoke, call) => {
      if (call <= 2) {
        await noDeliveryHttp(setup);
        throw new Prisma.PrismaClientKnownRequestError("Raw query failed", { code: "P2010", clientVersion: "7.5.0",
          meta: { driverAdapterError: { cause: { kind: "SocketTimeout", originalCode: call === 1 ? "5" : "517" } } } });
      }
      return invoke();
    });
    assert.equal((await candidate.instance.runOnce())?.status, "SUCCEEDED");
    assert.equal((await setup.q.db.socialDelivery.findUniqueOrThrow({ where: { id: setup.deliveryId } })).attempts, 1);
    await publicationCounts(setup, "1"); assert.equal(await candidate.instance.runOnce(), null); await publicationCounts(setup, "1");
  } finally { await setup.q.close(); }
});

test("raw-query errors with missing or unknown structured driver causes remain fatal without HTTP", { timeout: 45_000 }, async () => {
  const setup = await queued();
  try {
    for (const meta of [undefined, { driverAdapterError: { cause: { kind: "SocketTimeout", originalCode: "999" } } }]) {
      const unknown = new Prisma.PrismaClientKnownRequestError("Raw query failed", { code: "P2010", clientVersion: "7.5.0", meta });
      const candidate = worker(setup, async () => { throw unknown; });
      await assert.rejects(candidate.instance.runOnce(), error => error === unknown); assert.equal(candidate.calls(), 1);
      const untouched = await setup.q.db.socialDelivery.findUniqueOrThrow({ where: { id: setup.deliveryId } });
      assert.equal(untouched.status, "QUEUED"); assert.equal(untouched.attempts, 0); await noDeliveryHttp(setup);
    }
  } finally { await setup.q.close(); }
});
