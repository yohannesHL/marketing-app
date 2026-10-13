import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import {
  XClient,
  type XPriceSchedule,
} from "../../apps/web/src/server/providers/x";
import {
  XSocialProvider,
  xSocialRegistration,
} from "../../apps/web/src/server/social/providers/x";
import { SecurityError } from "../../apps/web/src/server/security/errors";
import {
  SocialProviderFailure,
  type SocialProviderCall,
  type SocialProviderContext,
  type SocialProgress,
} from "../../apps/web/src/server/social/types";
import { startMockoon } from "../support/mockoon";
let mock: Awaited<ReturnType<typeof startMockoon>>;
let time = new Date("2026-10-13T12:00:00Z");
const now = () => new Date(time);
const prices: XPriceSchedule = {
  USER_READ: 10000,
  POST_READ: 5000,
  POST_CREATE: 15000,
  POST_CREATE_URL: 200000,
  POST_DELETE: 10000,
  MEDIA_UPLOAD: 1000,
  MEDIA_INIT: 1000,
  MEDIA_APPEND: 1000,
  MEDIA_FINALIZE: 1000,
  MEDIA_STATUS: 1000,
};
const config = () => ({
  clientId: "x-client",
  clientSecret: "fixture-x-secret",
  redirectUri: "https://launchpad.test/api/connections/x/callback",
  mockoonEnabled: true,
  mockoonBaseUrl: mock.origin,
  now,
});
const mediaConfig = () => ({ mediaOrigin: mock.origin, prices, now });
before(async () => {
  mock = await startMockoon("tests/mockoon/x.json");
});
after(async () => {
  await mock?.stop();
});
function harness(
  body = "Fixture text",
  format: "TEXT" | "IMAGE" | "SHORT_VIDEO" = "TEXT",
) {
  const saved: SocialProgress[] = [],
    events: string[] = [],
    reservations: {
      operation: string;
      costMicros: number;
      maxApiCostMicros: number;
    }[] = [];
  const call: SocialProviderCall = {
    mode: "mock",
    accessToken: "x-access",
    authorizationId: "fixture-authorization",
    authorizationGeneration: 1,
    providerUserId: "1001",
    verifyCurrent: async () => {
      events.push("guard");
    },
    authorizeApiCost: async (input) => {
      reservations.push(input);
      if (
        reservations.reduce((n, r) => n + r.costMicros, 0) >
        input.maxApiCostMicros
      )
        throw new SecurityError(
          "API_COST_LIMIT",
          409,
          "The reviewed cost ceiling was reached.",
        );
    },
    destination: {
      externalId: "1001",
      kind: "X_PROFILE",
      metadata: { canWrite: "ALLOWED" },
    },
    media:
      format === "TEXT"
        ? []
        : [
            {
              id: format === "IMAGE" ? "asset-image" : "asset-video",
              mime: format === "IMAGE" ? "image/png" : "video/mp4",
              bytes: 8,
              width: format === "IMAGE" ? 64 : 720,
              height: format === "IMAGE" ? 64 : 1280,
              durationMs: format === "IMAGE" ? null : 1000,
              metadata:
                format === "IMAGE" ? {} : { videoCodec: "h264", fps: 30 },
              url: `${mock.origin}/api/social/media/${format === "IMAGE" ? "asset-image" : "asset-video"}/content?expires=1791900000&signature=${"a".repeat(64)}`,
            },
          ],
  };
  const context: SocialProviderContext = {
    deliveryId: "delivery-" + body,
    revisionId: "revision-" + body,
    content: {
      title: "Internal draft",
      body,
      format,
      providerOptions: {
        madeWithAi: false,
        paidPartnership: false,
        maxApiCostMicros: 1000000,
      },
    },
    rpc: async (phase, fn) => {
      events.push(phase);
      try {
        return await fn(call);
      } catch (error) {
        if (
          phase === "PUBLISH" &&
          error instanceof SocialProviderFailure &&
          error.definitive
        )
          events.push("definitive-rejection");
        throw error;
      }
    },
    checkpoint: async (p) => {
      events.push("checkpoint");
      saved.push(structuredClone(p));
    },
  };
  return {
    call,
    context,
    saved,
    events,
    reservations,
    provider: new XSocialProvider(config(), mediaConfig()),
  };
}
test("text publication requires explicit account, cost/disclosure controls and persists receipt before verified readback", async () => {
  const h = harness();
  await h.provider.validate(h.context);
  const prepared = await h.provider.prepare(h.context, {});
  const result = await h.provider.publish(h.context, prepared);
  assert.deepEqual(result, {
    externalId: "6001",
    publishUrl: "https://x.com/i/web/status/6001",
  });
  assert.equal(h.events.filter((x) => x === "PUBLISH").length, 1);
  assert.equal(h.saved.at(-1)!.postId, "6001");
  assert.deepEqual(
    h.reservations.map((r) => r.operation),
    ["USER_READ", "USER_READ", "USER_READ", "POST_CREATE", "POST_READ"],
  );
  assert.equal(
    h.reservations.reduce((n, r) => n + r.costMicros, 0),
    50000,
  );
  assert.doesNotMatch(
    JSON.stringify(h.saved),
    /x-access|signature|expires=|clientSecret/,
  );
  const restarted = harness();
  assert.equal(
    (await restarted.provider.status(restarted.context, h.saved.at(-1)!))
      .status,
    "PUBLISHED",
  );
  assert.equal(restarted.events.includes("PUBLISH"), false);
});
test("image upload uses actual owned bytes and expiry, then attaches exact ready media receipt", async () => {
  const h = harness("Fixture image", "IMAGE");
  const prepared = await h.provider.prepare(h.context, {});
  assert.equal((prepared.media as any[])[0].id, "5001");
  assert.equal((prepared.media as any[])[0].ready, true);
  assert.equal(
    (prepared.media as any[])[0].expiresAt,
    "2026-10-14T12:00:00.000Z",
  );
  assert.equal(
    (await h.provider.publish(h.context, prepared)).externalId,
    "6002",
  );
  assert.equal(
    h.reservations.filter((r) => r.operation === "MEDIA_UPLOAD").length,
    1,
  );
});
test("video INIT/chunk/finalize checkpoints processing; restart honors check_after then reuses existing upload", async () => {
  const h = harness("Fixture video", "SHORT_VIDEO");
  await assert.rejects(
    h.provider.prepare(h.context, {}),
    (e) =>
      e instanceof SocialProviderFailure &&
      e.definitive &&
      e.retryAfterMs === 2000,
  );
  const receipt = h.saved.at(-1)!;
  assert.equal((receipt.media as any[])[0].id, "5002");
  assert.equal((receipt.media as any[])[0].nextSegment, 1);
  assert.equal((receipt.media as any[])[0].finalized, true);
  assert.equal(h.events.includes("PUBLISH"), false);
  const restarted = harness("Fixture video", "SHORT_VIDEO");
  await assert.rejects(
    restarted.provider.prepare(restarted.context, receipt),
    (e) => e instanceof SocialProviderFailure && e.retryAfterMs === 2000,
  );
  assert.equal(
    restarted.reservations.some((r) => r.operation === "MEDIA_STATUS"),
    false,
  );
  time = new Date(time.getTime() + 2000);
  await fetch(mock.origin + "/fixture/video-ready", { method: "POST" });
  const prepared = await restarted.provider.prepare(restarted.context, receipt);
  assert.equal((prepared.media as any[])[0].ready, true);
  assert.equal(
    restarted.reservations.filter((r) =>
      ["MEDIA_INIT", "MEDIA_APPEND", "MEDIA_FINALIZE"].includes(r.operation),
    ).length,
    0,
  );
  assert.equal(
    (await restarted.provider.publish(restarted.context, prepared)).externalId,
    "6003",
  );
});
test("optional upload media_key is not invented; readback proves the actual attachment ID", async () => {
  const h = harness("Fixture no-key", "IMAGE");
  h.call.accessToken = "x-nokey";
  const prepared = await h.provider.prepare(h.context, {});
  const media = prepared.media as { id: string; key?: string }[];
  assert.equal(media[0].id, "5004");
  assert.equal(media[0].key, undefined);
  assert.equal(
    (await h.provider.publish(h.context, prepared)).externalId,
    "6007",
  );
});
test("unknown create persists attempt fence and cannot resubmit or guess a timeline match", async () => {
  const h = harness("Fixture ambiguous"),
    prepared = await h.provider.prepare(h.context, {});
  await assert.rejects(
    h.provider.publish(h.context, prepared),
    (e) => e instanceof SocialProviderFailure && !e.definitive,
  );
  const receipt = h.saved.at(-1)!;
  assert.equal(receipt.createAttempted, true);
  assert.equal(receipt.postId, undefined);
  const restarted = harness("Fixture ambiguous");
  assert.deepEqual(
    await restarted.provider.status(restarted.context, receipt),
    { status: "UNKNOWN" },
  );
  await assert.rejects(
    restarted.provider.publish(restarted.context, receipt),
    (e) => e instanceof SocialProviderFailure && !e.definitive,
  );
  assert.equal(restarted.events.includes("PUBLISH"), false);
  assert.equal(restarted.reservations.length, 0);
});
test("credits require owner attention while429 is bounded safe retry; neither pretends publication", async () => {
  const credits = harness("Fixture credits");
  await assert.rejects(
    credits.provider.publish(
      credits.context,
      await credits.provider.prepare(credits.context, {}),
    ),
    { code: "PROVIDER_CREDITS_REQUIRED" },
  );
  assert.equal(credits.saved.at(-1)!.createAttempted, false);
  const quota = harness("Fixture rate");
  await assert.rejects(
    quota.provider.publish(
      quota.context,
      await quota.provider.prepare(quota.context, {}),
    ),
    (e) =>
      e instanceof SocialProviderFailure &&
      e.kind === "RATE_LIMIT" &&
      e.definitive &&
      e.retryAfterMs! <= 60000,
  );
  assert.equal(quota.saved.at(-1)!.createAttempted, false);
  assert.equal(quota.events.includes("definitive-rejection"), true);
});
test("missing budget seam, cost ceiling, stale authorization, mode and unsupported mixed media fail before sending", async () => {
  const noBudget = harness();
  delete noBudget.call.authorizeApiCost;
  await assert.rejects(noBudget.provider.validate(noBudget.context), {
    code: "API_COST_APPROVAL_REQUIRED",
  });
  const ceiling = harness();
  ceiling.context.content.providerOptions = {
    madeWithAi: false,
    paidPartnership: false,
    maxApiCostMicros: 49999,
  };
  await assert.rejects(ceiling.provider.validate(ceiling.context), {
    code: "API_COST_LIMIT",
  });
  assert.equal(ceiling.reservations.length, 0);
  const disclosure = harness();
  disclosure.context.content.providerOptions = { maxApiCostMicros: 100000 };
  await assert.rejects(disclosure.provider.validate(disclosure.context), {
    code: "INVALID_PROVIDER_OPTIONS",
  });
  const foreign = harness();
  foreign.call.providerUserId = "2002";
  await assert.rejects(foreign.provider.validate(foreign.context), {
    code: "INVALID_SELECTION",
  });
  const live = harness();
  live.call.mode = "live";
  await assert.rejects(live.provider.validate(live.context), {
    code: "CONNECTION_MODE_MISMATCH",
  });
  assert.equal(live.reservations.length, 0);
  const stale = harness();
  const prepared = await stale.provider.prepare(stale.context, {});
  stale.call.authorizationGeneration = 2;
  await assert.rejects(stale.provider.publish(stale.context, prepared), {
    code: "INVALID_PROVIDER_PROGRESS",
  });
  const revoked = harness();
  revoked.call.verifyCurrent = async () => {
    throw new SecurityError("STALE_CREDENTIALS", 409, "Grant changed.");
  };
  await assert.rejects(revoked.provider.validate(revoked.context), {
    code: "STALE_CREDENTIALS",
  });
  assert.equal(revoked.reservations.length, 0);
  const mixed = harness("Fixture video", "SHORT_VIDEO");
  mixed.call.media = [...mixed.call.media, ...mixed.call.media];
  await assert.rejects(mixed.provider.validate(mixed.context), {
    code: "UNSUPPORTED_CONTENT",
  });
});
test("expired uploaded media is refreshed before creating; owned URL redirects, truncated bytes and oversized media are rejected", async () => {
  const h = harness("Expiry fixture", "IMAGE");
  const prepared = await h.provider.prepare(h.context, {});
  (prepared.media as any[])[0].expiresAt = now().toISOString();
  const restarted = harness("Expiry fixture", "IMAGE");
  await restarted.provider.prepare(restarted.context, prepared);
  assert.equal(
    restarted.reservations.filter((r) => r.operation === "MEDIA_UPLOAD").length,
    1,
  );
  for (const id of ["asset-redirect", "asset-short"]) {
    const bad = harness("Bad media " + id, "IMAGE");
    bad.call.media[0].id = id;
    bad.call.media[0].url = `${mock.origin}/api/social/media/${id}/content?expires=1791900000&signature=${"a".repeat(64)}`;
    await assert.rejects(bad.provider.prepare(bad.context, {}), {
      code: "MEDIA_UNAVAILABLE",
    });
    assert.equal(bad.events.includes("PUBLISH"), false);
  }
  const url = harness("Bad origin", "IMAGE");
  url.call.media[0].url = url.call.media[0].url.replace(
    mock.origin,
    "http://attacker.test",
  );
  await assert.rejects(url.provider.prepare(url.context, {}), {
    code: "MEDIA_UNAVAILABLE",
  });
});
test("cancel stops uncreated work locally and deletes only known verified posts followed by actual not-found readback", async () => {
  const h = harness();
  assert.deepEqual(await h.provider.cancel(h.context, {}), { cancelled: true });
  const ambiguous = harness("Fixture ambiguous");
  const prepared = await ambiguous.provider.prepare(ambiguous.context, {});
  prepared.createAttempted = true;
  assert.deepEqual(
    await ambiguous.provider.cancel(ambiguous.context, prepared),
    { cancelled: false },
  );
  assert.equal(
    ambiguous.reservations.some((r) => r.operation === "POST_DELETE"),
    false,
  );
  // Receipt persisted by the completed text test; exact review and account binding remain required.
  const done = await h.provider.prepare(h.context, {});
  done.createAttempted = true;
  done.postId = "6001";
  assert.deepEqual(await h.provider.cancel(h.context, done), {
    cancelled: true,
  });
  assert.equal(
    h.reservations.filter((r) => r.operation === "POST_DELETE").length,
    1,
  );
  const restarted = harness();
  const deletionReceipt = h.saved.at(-1)!;
  assert.equal(deletionReceipt.deleteAccepted, true);
  assert.deepEqual(
    await restarted.provider.status(restarted.context, deletionReceipt),
    {
      status: "NOT_PUBLISHED",
    },
  );
  assert.deepEqual(
    await restarted.provider.cancel(restarted.context, deletionReceipt),
    {
      cancelled: true,
    },
  );
  assert.equal(
    restarted.reservations.some((r) => r.operation === "POST_DELETE"),
    false,
  );
  assert.equal(
    xSocialRegistration(config(), mediaConfig()).renewableCredentials,
    true,
  );
});
