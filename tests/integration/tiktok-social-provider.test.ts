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
import { SecurityError } from "../../apps/web/src/server/security/errors";
import {
  TikTokClient,
  TIKTOK_SCOPES,
  type TikTokCreator,
} from "../../apps/web/src/server/providers/tiktok";
import {
  TikTokSocialProvider,
  tiktokSocialRegistration,
} from "../../apps/web/src/server/social/providers/tiktok";
import { SocialPostService } from "../../apps/web/src/server/social/postService";
import { SocialDeliveryWorker } from "../../apps/web/src/server/social/deliveryWorker";
import {
  SocialProviderFailure,
  SocialProviderRegistry,
  type SocialProgress,
  type SocialProviderCall,
  type SocialProviderContext,
} from "../../apps/web/src/server/social/types";
import { startMockoon } from "../support/mockoon";
import { applyConnectionMigrations } from "../support/test-database";
let mock: Awaited<ReturnType<typeof startMockoon>>,
  directory: string,
  db: PrismaClient;
const now = () => new Date("2026-10-13T12:00:00Z");
const config = () => ({
  clientKey: "tt-client",
  clientSecret: "fixture-tt-secret",
  redirectUri: "https://launchpad.test/api/connections/tiktok/callback",
  now,
  mockoonEnabled: true,
  mockoonBaseUrl: mock.origin,
});
const mediaConfig = (audited = true) => ({
  verifiedMediaPrefix: `${mock.origin}/api/social/media/`,
  audited,
  now,
});
const client = () => new TikTokClient(config());
before(async () => {
  mock = await startMockoon("tests/mockoon/tiktok.json");
  directory = await mkdtemp(join(tmpdir(), "tiktok-delivery-"));
  const url = `file:${join(directory, "test.db")}`;
  const sql = createClient({ url });
  await applyConnectionMigrations(sql);
  sql.close();
  db = new PrismaClient({ adapter: new PrismaLibSql({ url }) });
});
after(async () => {
  await mock?.stop();
  await db?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});
const option = (creator: TikTokCreator, privacy = "PUBLIC_TO_EVERYONE") => ({
  creatorInfoVersion: creator.version,
  privacyLevel: privacy,
  disableComment: true,
  disableDuet: true,
  disableStitch: true,
  commercialContentDisclosure: false,
  brandContentToggle: false,
  brandOrganicToggle: false,
  musicUsageConsent: true,
  explicitPostingConsent: true,
  isAigc: false,
});
const mediaUrl = (id: string, expires = 1791900000) =>
  `${mock.origin}/api/social/media/${id}/content?expires=${expires}&signature=${"a".repeat(64)}`;
async function harness(
  scenario = "public",
  token = `tt-fixture-${scenario}`,
  audited = true,
) {
  const creator = await client().creatorInfo(token, "open-id-a"),
    saved: SocialProgress[] = [],
    events: string[] = [];
  const call: SocialProviderCall = {
    mode: "mock",
    accessToken: token,
    authorizationId: "fixture-authorization",
    authorizationGeneration: 1,
    providerUserId: "open-id-a",
    verifyCurrent: async () => {
      events.push("guard");
    },
    destination: {
      externalId: "open-id-a",
      kind: "TIKTOK_PROFILE",
      metadata: {
        canWrite: "ALLOWED",
        tiktokCreator: {
          ...creator,
          authorizationId: "fixture-authorization",
          authorizationGeneration: 1,
          checkedAt: now().toISOString(),
        },
      },
    },
    media: [
      {
        id: "asset-a",
        url: mediaUrl("asset-a"),
        mime: "video/mp4",
        bytes: 4200,
        width: 720,
        height: 1280,
        durationMs: 10000,
        metadata: { videoCodec: "h264", fps: 30 },
      },
    ],
  };
  const context: SocialProviderContext = {
    deliveryId: `delivery-${scenario}`,
    revisionId: `revision-${scenario}`,
    content: {
      title: "Internal draft label",
      body: `fixture-${scenario}`,
      format: "SHORT_VIDEO",
      providerOptions: option(
        creator,
        scenario === "private" ? "SELF_ONLY" : "PUBLIC_TO_EVERYONE",
      ),
    },
    rpc: async (phase, invoke) => {
      events.push(phase);
      return invoke(call);
    },
    checkpoint: async (value) => {
      events.push("checkpoint");
      saved.push(structuredClone(value));
    },
  };
  return {
    creator,
    call,
    context,
    saved,
    events,
    provider: new TikTokSocialProvider(config(), mediaConfig(audited)),
  };
}

test("adapter binds fresh reviewed creator controls and checkpoints accepted publish_id before confirming publication", async () => {
  const h = await harness();
  await h.provider.validate(h.context);
  const prepared = await h.provider.prepare(h.context, {});
  const published = await h.provider.publish(h.context, prepared);
  assert.equal(published.externalId, "7364839287461827391");
  assert.equal(published.publishUrl, undefined);
  assert.equal(h.events.filter((event) => event === "PUBLISH").length, 1);
  assert.equal(h.saved.at(-1)?.publishId, "v_pub_url~v2-1.public");
  assert.equal(
    h.events.indexOf("checkpoint") < h.events.lastIndexOf("PROCESS"),
    true,
  );
  assert.doesNotMatch(
    JSON.stringify(h.saved),
    /tt-access-a|signature=|videoUrl|client_secret/,
  );
  assert.equal(
    (await h.provider.status(h.context, h.saved.at(-1)!)).status,
    "PUBLISHED",
  );
});
test("unaudited mode only accepts private creator plus explicit SELF_ONLY and retains real private reference without fake URL", async () => {
  const h = await harness("private", "tt-private", false);
  await h.provider.validate(h.context);
  const result = await h.provider.publish(
    h.context,
    await h.provider.prepare(h.context, {}),
  );
  assert.equal(result.externalId, "v_pub_url~v2-1.private");
  assert.equal(result.publishUrl, undefined);
  const publicCreator = await harness("unaudited", "tt-access-a", false);
  await assert.rejects(publicCreator.provider.validate(publicCreator.context), {
    code: "INVALID_PROVIDER_OPTIONS",
  });
});
test("processing receipt survives restart and status never initializes another post", async () => {
  const h = await harness("pending"),
    prepared = await h.provider.prepare(h.context, {});
  await assert.rejects(
    h.provider.publish(h.context, prepared),
    (error) => error instanceof SocialProviderFailure && !error.definitive,
  );
  const receipt = h.saved.at(-1)!;
  assert.equal(receipt.publishId, "v_pub_url~v2-1.pending");
  const restarted = await harness("pending");
  assert.deepEqual(
    await restarted.provider.status(restarted.context, receipt),
    { status: "PENDING" },
  );
  assert.equal(restarted.events.includes("PUBLISH"), false);
  assert.equal(
    (await fetch(`${mock.origin}/fixture/complete/pending`, { method: "POST" }))
      .status,
    200,
  );
  assert.equal(
    (await restarted.provider.status(restarted.context, receipt)).status,
    "PUBLISHED",
  );
  assert.equal(restarted.events.includes("PUBLISH"), false);
  assert.deepEqual(await restarted.provider.status(restarted.context, {}), {
    status: "UNKNOWN",
  });
});
test("changed creator version, disabled interactions, mismatched identity and untrusted review metadata block sending", async () => {
  const changed = await harness("changed");
  changed.call.accessToken = "tt-changed";
  await assert.rejects(changed.provider.validate(changed.context), {
    code: "INVALID_PROVIDER_OPTIONS",
  });
  const interaction = await harness("interaction");
  interaction.context.content.providerOptions = {
    ...interaction.context.content.providerOptions,
    disableStitch: false,
  };
  await assert.rejects(interaction.provider.validate(interaction.context), {
    code: "INVALID_PROVIDER_OPTIONS",
  });
  const forged = await harness("forged");
  forged.call.destination.metadata = {
    tiktokCreator: {
      ...forged.creator,
      authorizationId: "another-authorization",
      authorizationGeneration: 1,
      checkedAt: now().toISOString(),
    },
  };
  await assert.rejects(forged.provider.validate(forged.context), {
    code: "REVIEW_REQUIRED",
  });
  const identity = await harness("identity");
  identity.call.providerUserId = "open-id-b";
  await assert.rejects(identity.provider.validate(identity.context), {
    code: "INVALID_SELECTION",
  });
  const reconnected = await harness("reconnected");
  reconnected.call.authorizationGeneration = 2;
  await assert.rejects(reconnected.provider.validate(reconnected.context), {
    code: "REVIEW_REQUIRED",
  });
  assert.equal(reconnected.events.includes("PUBLISH"), false);
});
test("only confirmed retryable failed receipts permit a fresh init; permanent failure remains blocked", async () => {
  const h = await harness("retry");
  await assert.rejects(
    h.provider.publish(h.context, await h.provider.prepare(h.context, {})),
    (error) => error instanceof SocialProviderFailure && !error.definitive,
  );
  const failed = h.saved.at(-1)!;
  assert.equal(failed.failedReason, "video_pull_failed");
  assert.deepEqual(await h.provider.status(h.context, failed), {
    status: "NOT_PUBLISHED",
  });
  const prepared = await h.provider.prepare(h.context, h.saved.at(-1)!);
  assert.equal(prepared.publishId, undefined);
  assert.deepEqual(prepared.retiredPublishIds, ["v_pub_url~v2-1.failed_retry"]);
  const result = await h.provider.publish(h.context, prepared);
  assert.equal(result.externalId, "7364839287461827391");
  assert.equal(h.saved.at(-1)!.publishId, "v_pub_url~v2-1.retry_completed");
  assert.equal(h.events.filter((event) => event === "PUBLISH").length, 2);

  const terminal = await harness("terminal");
  await assert.rejects(
    terminal.provider.publish(
      terminal.context,
      await terminal.provider.prepare(terminal.context, {}),
    ),
  );
  assert.deepEqual(
    await terminal.provider.status(terminal.context, terminal.saved.at(-1)!),
    { status: "NOT_PUBLISHED" },
  );
  await assert.rejects(
    terminal.provider.prepare(terminal.context, terminal.saved.at(-1)!),
    (error) =>
      error instanceof SocialProviderFailure &&
      error.kind === "TERMINAL" &&
      error.definitive,
  );
  assert.equal(terminal.events.filter((event) => event === "PUBLISH").length, 1);
});
test("media HEAD rejects expired/redirected/incorrect bytes before any publication and verifies guard before every request", async () => {
  for (const [scenario, asset] of [
    ["expired", "asset-expired"],
    ["redirect", "asset-redirect"],
    ["size", "asset-bad-size"],
  ]) {
    const h = await harness(scenario);
    h.call.media[0].id = asset;
    h.call.media[0].url = mediaUrl(asset);
    await assert.rejects(h.provider.prepare(h.context, {}), {
      code: "MEDIA_UNAVAILABLE",
    });
    assert.equal(h.events.includes("PUBLISH"), false);
  }
  const tooShort = await harness("short-url");
  tooShort.call.media[0].url = mediaUrl("asset-a", 1791893000);
  await assert.rejects(tooShort.provider.prepare(tooShort.context, {}), {
    code: "MEDIA_UNAVAILABLE",
  });
  const guarded = await harness("guard");
  let calls = 0;
  guarded.call.verifyCurrent = async () => {
    if (++calls >= 2)
      throw new SecurityError("STALE_CREDENTIALS", 409, "Grant changed.");
  };
  await assert.rejects(guarded.provider.validate(guarded.context), {
    code: "STALE_CREDENTIALS",
  });
  assert.equal(calls, 2);
  assert.equal(guarded.events.includes("PUBLISH"), false);
  const live = await harness("live");
  live.call.mode = "live";
  await assert.rejects(live.provider.validate(live.context), {
    code: "CONNECTION_MODE_MISMATCH",
  });
});
test("best-effort cancellation uses URL-download cancel plus readback and never deletes published posts", async () => {
  const h = await harness("cancel"),
    prepared = await h.provider.prepare(h.context, {});
  await assert.rejects(h.provider.publish(h.context, prepared));
  assert.deepEqual(await h.provider.cancel(h.context, h.saved.at(-1)!), {
    cancelled: true,
  });
  const complete = await harness("public");
  const evidence = {
    provider: "tiktok",
    revisionId: complete.context.revisionId,
    mediaId: "asset-a",
    openId: "open-id-a",
    creatorInfoVersion: complete.creator.version,
    contentDigest: await import("node:crypto").then((m) =>
      m
        .createHash("sha256")
        .update(
          JSON.stringify([
            complete.context.content.body,
            complete.context.content.providerOptions,
          ]),
        )
        .digest("hex"),
    ),
    privacyLevel: "PUBLIC_TO_EVERYONE",
    retiredPublishIds: [],
    publishId: "v_pub_url~v2-1.public",
  };
  assert.deepEqual(await complete.provider.cancel(complete.context, evidence), {
    cancelled: false,
  });
});

test("real durable worker keeps accepted processing and ambiguous init uncertain; restart only reconciles saved receipt", async () => {
  const origin = "https://launchpad.test",
    auth = new CustomerAuth(db, { origin }, now),
    vault = new CredentialVault(
      { fixture: Buffer.alloc(32, 62).toString("base64") },
      "fixture",
    ),
    connections = new CustomerConnections(db, auth, vault, now);
  for (const scenario of ["worker-pending", "ambiguous"]) {
    const email = `tiktok-${scenario}@example.test`,
      password = "isolated TikTok customer fixture password";
    await auth.provisionCustomer({ name: scenario, email, password });
    const login = await auth.login(email, password),
      principal = await auth.requireSession(
        new Request(origin, {
          headers: { cookie: login.cookie.split(";")[0] },
        }),
      );
    const oauth = {
      provider: "TIKTOK" as const,
      capability: "SOCIAL" as const,
      redirectUri: config().redirectUri,
      scopes: [...TIKTOK_SCOPES],
      pkce: false,
    };
    const start = await connections.beginOAuth(principal, oauth),
      verified = await client().exchangeCode({ code: "success" }),
      grant = await connections.completeAuthorization(
        principal,
        start.state,
        oauth,
        { ...verified, connectionMode: "MOCK" },
      );
    const destination = await connections.registerDestination(
        principal,
        grant.id,
        {
          kind: "TIKTOK_PROFILE",
          externalId: "open-id-a",
          name: "Fixture TikTok creator",
        },
      ),
      creator = await client().creatorInfo("tt-access-a", "open-id-a"),
      raw = await db.providerAuthorization.findUniqueOrThrow({
        where: { id: grant.id },
      });
    await db.connectionDestination.update({
      where: { id: destination.id },
      data: {
        selected: true,
        metadata: {
          canWrite: "ALLOWED",
          tiktokCreator: {
            ...creator,
            authorizationId: grant.id,
            authorizationGeneration: raw.generation,
            checkedAt: now().toISOString(),
          },
        },
        lastCheckedAt: now(),
      },
    });
    // Trusted media database fixture exercises worker/HTTP boundaries. Media-store
    // suites separately verify real probing, hashing, signed links and physical bytes.
    const media = await db.socialMediaAsset.create({
      data: {
        ownerId: principal.userId,
        storageKey: `fixture-${scenario}`,
        digest: "a".repeat(64),
        mime: "video/mp4",
        type: "VIDEO",
        bytes: 4200,
        width: 720,
        height: 1280,
        durationMs: 10000,
        metadata: { videoCodec: "h264", fps: 30 },
        verifiedAt: now(),
        status: "AVAILABLE",
      },
    });
    const registry = new SocialProviderRegistry();
    registry.register(tiktokSocialRegistration(config(), mediaConfig()));
    const settings = {
      mode: "mock" as const,
      writesEnabled: true,
      approvedProviders: ["TIKTOK:TIKTOK_PROFILE"],
    };
    const service = new SocialPostService(db, auth, settings, registry, now),
      post = await service.create(principal, {
        title: "Internal social draft",
        body: `fixture-${scenario}`,
        mediaIds: [media.id],
        variants: [
          {
            destinationId: destination.id,
            format: "SHORT_VIDEO",
            providerOptions: option(creator),
          },
        ],
      });
    await service.approve(principal, post.id, post.revision!.id, [
      destination.id,
    ]);
    const queued = await service.enqueue(principal, post.id, {
      revisionId: post.revision!.id,
      destinationIds: [destination.id],
      enqueueId: `tiktok-${scenario}-enqueue`,
      dueAt: now().toISOString(),
      timeZone: "UTC",
    });
    const worker = () =>
      new SocialDeliveryWorker(
        db,
        vault,
        registry,
        settings,
        async ({ media }) =>
          media.map((m) => ({ id: m.id, url: mediaUrl(m.id) })),
        now,
      );
    assert.equal((await worker().runOnce())?.status, "UNCERTAIN");
    assert.equal(await worker().runOnce(), null);
    const progress = await db.socialDeliveryProgress.findUniqueOrThrow({
      where: { deliveryId: queued.deliveries[0].id },
    });
    assert.doesNotMatch(
      progress.encryptedState,
      /tt-access-a|signature=|publish_id/,
    );
    if (scenario === "worker-pending") {
      assert.equal(
        (
          await fetch(`${mock.origin}/fixture/complete/worker_pending`, {
            method: "POST",
          })
        ).status,
        200,
      );
      assert.equal(
        (await worker().reconcileOnce(queued.deliveries[0].id))?.status,
        "SUCCEEDED",
      );
      assert.equal(
        (await service.get(principal, post.id)).deliveries[0].externalId,
        "7364839287461827391",
      );
    } else {
      assert.equal(
        (await worker().reconcileOnce(queued.deliveries[0].id))?.status,
        "UNCERTAIN",
      );
      assert.equal(await worker().runOnce(), null);
    }
    const publicDTO = await service.get(principal, post.id);
    assert.doesNotMatch(
      JSON.stringify(publicDTO),
      /encryptedState|tt-access-a|tt-refresh-a|signature=/,
    );
  }
});
