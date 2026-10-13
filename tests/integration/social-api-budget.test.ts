import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import {
  PrismaClient,
  type Prisma,
} from "../../apps/web/src/generated/prisma/client";
import {
  SocialApiBudget,
  type ApiBudgetBinding,
  type ApiBudgetOwnerPolicy,
} from "../../apps/web/src/server/social/apiBudget";
import { SecurityError } from "../../apps/web/src/server/security/errors";
import { applyConnectionMigrations } from "../support/test-database";
let directory: string, db: PrismaClient, dbUrl: string;
let time = new Date("2026-10-13T12:00:00Z");
const now = () => new Date(time);
const lease = "a".repeat(64);
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "social-api-budget-"));
  const url = `file:${join(directory, "test.db")}`;
  dbUrl = url;
  const sql = createClient({ url });
  await applyConnectionMigrations(sql);
  sql.close();
  db = new PrismaClient({ adapter: new PrismaLibSql({ url }) });
});
after(async () => {
  await db?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function job(
  name: string,
  cap: number | string = 30000,
  mode: "mock" | "live" = "mock",
  ownerId?: string,
) {
  const owner = ownerId
    ? await db.user.findUniqueOrThrow({ where: { id: ownerId } })
    : await db.user.create({ data: { name } });
  const grant = await db.providerAuthorization.create({
    data: {
      userId: owner.id,
      provider: "X",
      providerUserId: name,
      capability: "SOCIAL",
      scopes: ["tweet.write"],
      connectionMode: mode.toUpperCase(),
    },
  });
  const dest = await db.connectionDestination.create({
    data: {
      authorizationId: grant.id,
      externalId: name,
      kind: "X_PROFILE",
      name,
      selected: true,
      metadata: { canWrite: "ALLOWED" },
    },
  });
  const post = await db.socialPost.create({
    data: { ownerId: owner.id, title: name },
  });
  const revision = await db.socialPostRevision.create({
    data: {
      postId: post.id,
      number: 1,
      title: name,
      body: "Caption",
      contentDigest: "b".repeat(64),
      reviewedAt: now(),
      reviewedById: owner.id,
      approvedDestinations: [dest.id],
    },
  });
  const variant = await db.socialPostVariant.create({
    data: {
      revisionId: revision.id,
      destinationId: dest.id,
      format: "TEXT",
      body: "Caption",
      mediaIds: [],
      providerOptions: { maxApiCostMicros: cap },
    },
  });
  const enqueue = await db.socialEnqueue.create({
    data: {
      ownerId: owner.id,
      key: name,
      postId: post.id,
      revisionId: revision.id,
      requestDigest: "c".repeat(64),
      dueAt: now(),
      timeZone: "UTC",
      destinationIds: [dest.id],
    },
  });
  const delivery = await db.socialDelivery.create({
    data: {
      postId: post.id,
      revisionId: revision.id,
      variantId: variant.id,
      destinationId: dest.id,
      enqueueId: enqueue.id,
      authorizationId: grant.id,
      authorizationGeneration: 1,
      postGeneration: 1,
      connectionMode: mode.toUpperCase(),
      requiredScopes: [],
      dueAt: now(),
      timeZone: "UTC",
      status: "LEASED",
      leaseTokenHash: lease,
      leaseUntil: new Date(now().getTime() + 864000000),
      attempts: 1,
    },
  });
  return { owner, grant, post, revision, variant, delivery, mode };
}
type Job = Awaited<ReturnType<typeof job>>;
function verifier(j: Job) {
  return async (tx: Prisma.TransactionClient): Promise<ApiBudgetBinding> => {
    const d = await tx.socialDelivery.findUniqueOrThrow({
      where: { id: j.delivery.id },
      include: {
        post: true,
        revision: true,
        variant: true,
        destination: { include: { authorization: true } },
      },
    });
    const g = d.destination.authorization;
    if (
      d.post.ownerId !== j.owner.id ||
      d.leaseTokenHash !== lease ||
      d.status !== "LEASED" ||
      !d.leaseUntil ||
      d.leaseUntil <= now()
    )
      throw new SecurityError("LEASE_LOST", 409, "Lease changed.");
    if (
      d.cancellationRequested ||
      d.post.generation !== d.postGeneration ||
      d.post.currentRevision !== d.revision.number ||
      !d.revision.reviewedAt ||
      d.revision.reviewedById !== j.owner.id ||
      !(d.revision.approvedDestinations as string[]).includes(d.destinationId)
    )
      throw new SecurityError("STALE_REVISION", 409, "Review changed.");
    if (
      g.generation !== d.authorizationGeneration ||
      g.status !== "CONNECTED" ||
      g.userId !== j.owner.id ||
      !d.destination.selected ||
      !d.destination.available
    )
      throw new SecurityError(
        "STALE_CREDENTIALS",
        409,
        "Authorization changed.",
      );
    return {
      ownerId: j.owner.id,
      deliveryId: d.id,
      revisionId: d.revisionId,
      provider: "X",
      mode: j.mode,
      authorizationId: g.id,
      authorizationGeneration: g.generation,
      credentialVersion: g.credentialVersion,
      leaseHash: lease,
      reviewedMaxApiCostMicros: (d.variant.providerOptions as any)
        .maxApiCostMicros,
    };
  };
}
const policy = (
  j: Job,
  daily = 100000,
  delivery = 100000,
): ApiBudgetOwnerPolicy => ({
  ownerId: j.owner.id,
  mode: j.mode,
  dailyLimitMicros: daily,
  deliveryLimitMicros: delivery,
  operationCeilings: { USER_READ: 10000, POST_CREATE: 15000 },
});
const request = (
  j: Job,
  cap = 30000,
  operation = "USER_READ",
  costMicros = 10000,
) => ({
  deliveryId: j.delivery.id,
  mode: j.mode,
  operation,
  costMicros,
  maxApiCostMicros: cap,
});
test("per-HTTP allocations persist across restarts/retries and are labelled estimates, never bills", async () => {
  const j = await job("persist", 25000);
  const b = new SocialApiBudget(db, [policy(j)], now);
  const first = await b.reserve(request(j, 25000), verifier(j));
  assert.equal(first.kind, "ESTIMATED_API_ALLOCATION");
  assert.equal(first.allocatedDeliveryMicros, "10000");
  const restarted = new SocialApiBudget(db, [policy(j)], now);
  await restarted.reserve(request(j, 25000), verifier(j));
  await assert.rejects(restarted.reserve(request(j, 25000), verifier(j)), {
    code: "API_COST_LIMIT",
  });
  assert.equal(
    await db.socialApiCostReservation.count({
      where: { deliveryId: j.delivery.id },
    }),
    2,
  );
  assert.equal(
    (
      await db.socialApiCostReservation.aggregate({
        where: { deliveryId: j.delivery.id },
        _sum: { costMicros: true },
      })
    )._sum.costMicros,
    20000n,
  );
});
test("owner daily allocation is aggregate across jobs and owner/mode policies cannot borrow each other", async () => {
  const a = await job("owner-daily-a", 50000),
    b = await job("owner-daily-b", 50000, "mock", a.owner.id),
    other = await job("owner-other", 50000),
    live = await job("owner-live", 50000, "live", a.owner.id);
  const ledger = new SocialApiBudget(
    db,
    [policy(a, 25000), policy(other, 10000)],
    now,
  );
  await ledger.reserve(request(a, 50000), verifier(a));
  await ledger.reserve(request(b, 50000), verifier(b));
  await assert.rejects(ledger.reserve(request(b, 50000), verifier(b)), {
    code: "API_COST_LIMIT",
  });
  await ledger.reserve(request(other, 50000), verifier(other));
  await assert.rejects(ledger.reserve(request(live, 50000), verifier(live)), {
    code: "API_COST_APPROVAL_REQUIRED",
  });
  assert.equal(
    await db.socialApiCostReservation.count({
      where: { deliveryId: live.delivery.id },
    }),
    0,
  );
});
test("lifetime reviewed delivery ceiling does not reset at midnight or after cancellation/job deletion", async () => {
  const j = await job("lifetime", 15000),
    ledger = new SocialApiBudget(db, [policy(j)], now);
  await ledger.reserve(request(j, 15000), verifier(j));
  time = new Date("2026-10-14T00:00:01Z");
  await assert.rejects(ledger.reserve(request(j, 15000), verifier(j)), {
    code: "API_COST_LIMIT",
  });
  await db.socialPost.delete({ where: { id: j.post.id } });
  assert.equal(
    await db.socialApiCostReservation.count({
      where: { deliveryId: j.delivery.id },
    }),
    1,
  );
  assert.equal(
    (
      await db.socialApiBudgetWindow.findFirstOrThrow({
        where: { ownerId: j.owner.id },
      })
    ).reservedMicros,
    10000n,
  );
});
test("immutable cap, exact operation bound, allowlist and safe integer limits fail before allocation", async () => {
  const j = await job("invalid"),
    ledger = new SocialApiBudget(db, [policy(j)], now);
  for (const bad of [
    { ...request(j), maxApiCostMicros: 40000 },
    { ...request(j), operation: "UNKNOWN" },
    { ...request(j), costMicros: 0 },
    { ...request(j), mode: "live" as const },
  ])
    await assert.rejects(ledger.reserve(bad, verifier(j)), {
      code: "API_COST_APPROVAL_REQUIRED",
    });
  await assert.rejects(
    ledger.reserve(
      { ...request(j), costMicros: Number.MAX_SAFE_INTEGER + 1 },
      verifier(j),
    ),
    { code: "INVALID_API_COST" },
  );
  assert.equal(
    await db.socialApiCostReservation.count({
      where: { deliveryId: j.delivery.id },
    }),
    0,
  );
  assert.throws(
    () =>
      new SocialApiBudget(db, [
        { ...policy(j), operationCeilings: { UNKNOWN: 1 } },
      ]),
    { code: "API_COST_APPROVAL_REQUIRED" },
  );
});
test("lease cancellation revision and grant fences run inside transaction; changed second verification rolls back counters", async () => {
  for (const mutation of ["lease", "cancel", "revision", "grant"]) {
    const j = await job("fence-" + mutation),
      ledger = new SocialApiBudget(db, [policy(j)], now);
    if (mutation === "lease")
      await db.socialDelivery.update({
        where: { id: j.delivery.id },
        data: { leaseTokenHash: "b".repeat(64) },
      });
    if (mutation === "cancel")
      await db.socialDelivery.update({
        where: { id: j.delivery.id },
        data: { cancellationRequested: true },
      });
    if (mutation === "revision")
      await db.socialPost.update({
        where: { id: j.post.id },
        data: { generation: 2 },
      });
    if (mutation === "grant")
      await db.providerAuthorization.update({
        where: { id: j.grant.id },
        data: { generation: 2 },
      });
    await assert.rejects(ledger.reserve(request(j), verifier(j)));
    assert.equal(
      await db.socialApiCostReservation.count({
        where: { deliveryId: j.delivery.id },
      }),
      0,
    );
  }
  const j = await job("second-verify"),
    ledger = new SocialApiBudget(db, [policy(j)], now);
  let calls = 0;
  await assert.rejects(
    ledger.reserve(request(j), async (tx) => {
      const b = await verifier(j)(tx);
      if (++calls === 2) b.credentialVersion++;
      return b;
    }),
    { code: "STALE_CREDENTIALS" },
  );
  assert.equal(calls, 2);
  assert.equal(
    await db.socialApiBudgetWindow.count({ where: { ownerId: j.owner.id } }),
    0,
  );
});
test("concurrent jobs cannot overdraw one owner budget and failed allocations do not increment", async () => {
  const a = await job("race-a", 50000),
    b = await job("race-b", 50000, "mock", a.owner.id),
    ledger = new SocialApiBudget(db, [policy(a, 15000)], now);
  const competitor = new PrismaClient({
    adapter: new PrismaLibSql({ url: dbUrl }),
  });
  const other = new SocialApiBudget(competitor, [policy(a, 15000)], now);
  const results = await Promise.allSettled([
    ledger.reserve(request(a, 50000), verifier(a)),
    other.reserve(request(b, 50000), verifier(b)),
  ]);
  await competitor.$disconnect();
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  const rejected = results.find(
    (r) => r.status === "rejected",
  ) as PromiseRejectedResult;
  assert.equal(rejected.reason.code, "API_COST_LIMIT");
  assert.equal(
    (
      await db.socialApiBudgetWindow.findFirstOrThrow({
        where: { ownerId: a.owner.id },
      })
    ).reservedMicros,
    10000n,
  );
  assert.equal(
    await db.socialApiCostReservation.count({ where: { ownerId: a.owner.id } }),
    1,
  );
});
test("large safe micros use BigInt without32-bit overflow; configured delivery ceiling remains enforced", async () => {
  const j = await job("large", "5000000000");
  const p = policy(j, 5000000000, 3000000000);
  p.operationCeilings = { POST_CREATE: 2500000000 };
  const ledger = new SocialApiBudget(db, [p], now);
  const result = await ledger.reserve(
    request(j, 5000000000, "POST_CREATE", 2500000000),
    verifier(j),
  );
  assert.equal(result.allocatedDeliveryMicros, "2500000000");
  await assert.rejects(
    ledger.reserve(
      request(j, 5000000000, "POST_CREATE", 2500000000),
      verifier(j),
    ),
    { code: "API_COST_LIMIT" },
  );
});

test("transaction conflict retries reuse one allocation ID and stop after a bounded budget", async () => {
  const j = await job("retry-conflict"),
    ledger = new SocialApiBudget(db, [policy(j)], now);
  let calls = 0;
  const result = await ledger.reserve(request(j), async (tx) => {
    if (++calls === 1)
      throw Object.assign(new Error("Synthetic transaction conflict."), {
        code: "P2034",
      });
    return verifier(j)(tx);
  });
  assert.equal(calls, 3);
  assert.equal(result.allocatedDeliveryMicros, "10000");
  assert.equal(
    await db.socialApiCostReservation.count({
      where: { deliveryId: j.delivery.id },
    }),
    1,
  );
  const blocked = await job("retry-exhausted");
  let attempts = 0;
  await assert.rejects(
    new SocialApiBudget(db, [policy(blocked)], now).reserve(
      request(blocked),
      async () => {
        attempts++;
        throw Object.assign(new Error("Synthetic transaction conflict."), {
          code: "P2034",
        });
      },
    ),
    { code: "P2034" },
  );
  assert.equal(attempts, 4);
  assert.equal(
    await db.socialApiCostReservation.count({
      where: { deliveryId: blocked.delivery.id },
    }),
    0,
  );
});
