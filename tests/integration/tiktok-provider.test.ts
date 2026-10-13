import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import {
  TikTokClient,
  TIKTOK_SCOPES,
  validateTikTokControls,
  validateTikTokMedia,
  type TikTokControls,
} from "../../apps/web/src/server/providers/tiktok";
import { SecurityError } from "../../apps/web/src/server/security/errors";
import { startMockoon } from "../support/mockoon";
let mock: Awaited<ReturnType<typeof startMockoon>>, client: TikTokClient;
const now = () => new Date("2026-10-13T12:00:00Z");
const config = {
  clientKey: "tt-client",
  clientSecret: "fixture-tt-secret",
  redirectUri: "https://launchpad.test/api/connections/tiktok/callback",
  now,
};
before(async () => {
  mock = await startMockoon("tests/mockoon/tiktok.json");
  client = new TikTokClient({
    ...config,
    mockoonEnabled: true,
    mockoonBaseUrl: mock.origin,
    verifiedMediaPrefix: `${mock.origin}/api/social/media/`,
  });
});
after(async () => {
  await mock?.stop();
});
const url = (asset = "asset-a", expires = 1791900000) =>
  `${mock.origin}/api/social/media/${asset}/content?expires=${expires}&signature=${"a".repeat(64)}`;
const options = (version = "a".repeat(64)): TikTokControls => ({
  privacyLevel: "PUBLIC_TO_EVERYONE",
  disableComment: true,
  disableDuet: true,
  disableStitch: true,
  commercialContentDisclosure: false,
  brandContentToggle: false,
  brandOrganicToggle: false,
  musicUsageConsent: true,
  explicitPostingConsent: true,
  isAigc: false,
  creatorInfoVersion: version,
});

test("confidential web OAuth uses static HTTPS redirect, least scopes and no undocumented PKCE", async () => {
  const live = new TikTokClient(config),
    auth = new URL(
      live.authorizationUrl({ state: "server-bound-state-value" }),
    );
  assert.equal(auth.origin, "https://www.tiktok.com");
  assert.equal(auth.pathname, "/v2/auth/authorize/");
  assert.equal(auth.searchParams.get("scope"), TIKTOK_SCOPES.join(","));
  assert.equal(auth.searchParams.get("client_key"), config.clientKey);
  assert.equal(auth.searchParams.get("state"), "server-bound-state-value");
  assert.equal(auth.searchParams.get("redirect_uri"), config.redirectUri);
  assert.equal(auth.searchParams.has("code_challenge"), false);
  assert.equal(live.pkce, false);
  const grant = await client.exchangeCode({ code: "success" });
  assert.equal(grant.providerUserId, "open-id-a");
  assert.equal(grant.name, "Fixture TikTok creator");
  assert.equal(grant.expiresAt.toISOString(), "2026-10-14T12:00:00.000Z");
  assert.equal(
    grant.refreshExpiresAt.toISOString(),
    "2027-10-13T12:00:00.000Z",
  );
  assert.deepEqual(grant.scopes, [...TIKTOK_SCOPES]);
});
test("token refresh verifies original open_id, rotates refresh token and trusts actual remaining expiry", async () => {
  const renewed = await client.renewVerified({
    providerUserId: "open-id-a",
    refreshToken: "tt-refresh-a",
  });
  assert.equal(renewed.refreshToken, "tt-refresh-rotated");
  assert.equal(
    renewed.refreshExpiresAt.toISOString(),
    "2027-08-09T12:00:00.000Z",
  );
  assert.equal(
    (await client.renewVerified(renewed)).refreshToken,
    "tt-refresh-rotated",
  );
  for (const [code, error] of [
    ["missing-scope", "MISSING_PERMISSION"],
    ["bad-expiry", "INVALID_PROVIDER_RESPONSE"],
    ["no-refresh", "INVALID_PROVIDER_RESPONSE"],
    ["forged-subject", "PROVIDER_IDENTITY_MISMATCH"],
    ["revoked", "RECONNECT_REQUIRED"],
  ])
    await assert.rejects(client.exchangeCode({ code }), { code: error });
  await assert.rejects(
    client.exchangeCode({
      code: "wrong-subject",
      previous: { providerUserId: "open-id-a" },
    }),
    { code: "PROVIDER_IDENTITY_MISMATCH" },
  );
  await assert.rejects(
    client.renewVerified({
      providerUserId: "open-id-a",
      refreshToken: "tt-refresh-wrong",
    }),
    { code: "PROVIDER_IDENTITY_MISMATCH" },
  );
});
test("local OAuth consent denial preserves server state without inventing a grant", async () => {
  const state = "server-bound-consent-denial-state";
  const auth = new URL(client.authorizationUrl({ state }));
  auth.searchParams.set("fixture_consent", "denied");
  const response = await fetch(auth, { redirect: "manual" });
  assert.equal(response.status, 302);
  const callback = new URL(response.headers.get("location")!);
  assert.equal(callback.origin, "https://launchpad.test");
  assert.equal(callback.pathname, "/api/connections/tiktok/callback");
  assert.equal(callback.searchParams.get("state"), state);
  assert.equal(callback.searchParams.get("error"), "access_denied");
  assert.equal(callback.searchParams.has("code"), false);
});
test("fresh creator query returns identity, nickname, eligible choices and stable controls version", async () => {
  const creator = await client.creatorInfo("tt-access-a", "open-id-a");
  assert.equal(creator.nickname, "Fixture TikTok creator");
  assert.equal(creator.username, "fixture_creator");
  assert.equal(creator.maxDurationSeconds, 300);
  assert.equal(creator.stitchDisabled, true);
  assert.equal(
    creator.version,
    (await client.creatorInfo("tt-access-a", "open-id-a")).version,
  );
  assert.notEqual(
    creator.version,
    (await client.creatorInfo("tt-changed", "open-id-a")).version,
  );
  assert.equal(
    (
      await client.creatorInfo("tt-private", "open-id-a")
    ).privacyLevels.includes("FOLLOWER_OF_CREATOR"),
    true,
  );
  await assert.rejects(client.creatorInfo("tt-user-b", "open-id-a"), {
    code: "PROVIDER_IDENTITY_MISMATCH",
  });
  await assert.rejects(client.creatorInfo("tt-daily", "open-id-a"), {
    code: "CREATOR_UNAVAILABLE",
  });
  await assert.rejects(client.creatorInfo("tt-creator-quota", "open-id-a"), {
    code: "PROVIDER_RATE_LIMITED",
    retryAfterMs: 12000,
  });
  await assert.rejects(client.verifiedUser("tt-no-scope"), {
    code: "MISSING_PERMISSION",
  });
});
test("required controls never infer privacy, posting/music consent, commercial choice or disabled interactions", () => {
  const good = options();
  assert.deepEqual(validateTikTokControls(good, "Caption"), good);
  for (const patch of [
    { privacyLevel: undefined },
    { musicUsageConsent: false },
    { explicitPostingConsent: false },
    { disableComment: undefined },
    { commercialContentDisclosure: true },
    { brandContentToggle: true },
    {
      brandContentToggle: true,
      commercialContentDisclosure: true,
      privacyLevel: "SELF_ONLY",
    },
  ])
    assert.throws(
      () => validateTikTokControls({ ...good, ...patch }, "Caption"),
      { code: "INVALID_POST_CONTROLS" },
    );
  assert.throws(() => validateTikTokControls(good, "x".repeat(2201)), {
    code: "INVALID_POST_CONTROLS",
  });
});
test("actual inspected codec, frame rate, dimensions, duration and size govern video eligibility", () => {
  const video = {
    mime: "video/mp4",
    bytes: 4200,
    width: 720,
    height: 1280,
    durationMs: 10000,
    metadata: { videoCodec: "h264", fps: 30 },
  };
  assert.equal(validateTikTokMedia(video), video);
  for (const patch of [
    { metadata: {} },
    { metadata: { videoCodec: "av1", fps: 30 } },
    { metadata: { videoCodec: "h264", fps: 22 } },
    { width: 359 },
    { height: 4097 },
    { durationMs: 300001 },
    { bytes: 4_000_000_001 },
  ])
    assert.throws(() => validateTikTokMedia({ ...video, ...patch }, 300), {
      code: "INVALID_MEDIA",
    });
});
test("exact Direct Post body submits owned PULL_FROM_URL and accepted init is only a publish receipt", async () => {
  const creator = await client.creatorInfo("tt-access-a", "open-id-a");
  const result = await client.initVideo("tt-access-a", {
    caption: "fixture-public",
    controls: options(creator.version),
    videoUrl: url(),
  });
  assert.deepEqual(result, { publishId: "v_pub_url~v2-1.public" });
  const status = await client.postStatus("tt-access-a", result.publishId);
  assert.equal(status.status, "PUBLISH_COMPLETE");
  assert.deepEqual(status.publicPostIds, ["7364839287461827391"]);
  const privateStatus = await client.postStatus(
    "tt-private",
    "v_pub_url~v2-1.private",
  );
  assert.deepEqual(privateStatus.publicPostIds, []);
  assert.equal(
    (await client.postStatus("tt-access-a", "v_pub_url~v2-1.pending")).status,
    "PROCESSING_DOWNLOAD",
  );
});
test("nested API errors, quota and ambiguous init results remain sanitized and distinct", async () => {
  for (const [caption, code] of [
    ["fixture-quota", "PROVIDER_RATE_LIMITED"],
    ["fixture-unaudited", "UNAUDITED_RESTRICTION"],
    ["fixture-ambiguous", "INVALID_PROVIDER_RESPONSE"],
  ]) {
    await assert.rejects(
      client.initVideo("tt-api-errors", {
        caption,
        controls: options(),
        videoUrl: url(),
      }),
      (error: unknown) => {
        const e = error as { code: string; outcomeUnknown: boolean };
        assert.equal(e.code, code);
        assert.equal(e.outcomeUnknown, caption === "fixture-ambiguous");
        assert.doesNotMatch(
          JSON.stringify(error),
          /fixture-provider-secret|raw upstream/,
        );
        return true;
      },
    );
  }
  await assert.rejects(
    client.postStatus("tt-access-a", "v_pub_url~v2-1.other-user"),
    { code: "PROVIDER_PERMISSION_DENIED" },
  );
  await assert.rejects(
    client.postStatus("tt-access-a", "v_pub_url~v2-1.quota"),
    { code: "PROVIDER_RATE_LIMITED" },
  );
});
test("reviewed own-brand, third-party and AI disclosures map to documented wire fields", async () => {
  const result = await client.initVideo("tt-disclosure", {
    caption: "fixture-disclosure",
    controls: {
      ...options(),
      commercialContentDisclosure: true,
      brandContentToggle: true,
      brandOrganicToggle: true,
      isAigc: true,
    },
    videoUrl: url(),
  });
  assert.equal(result.publishId, "v_pub_url~v2-1.disclosure");
});
test("signed URL must remain live for an hour on the configured owned prefix", async () => {
  for (const bad of [
    url("asset-a", 1791893000),
    url().replace(mock.origin, "http://attacker.test"),
    url().replace("/api/social/media/", "/wrong-prefix/"),
    url() + "&extra=secret",
  ]) {
    await assert.rejects(
      client.initVideo("tt-bad-url", {
        caption: "fixture-public",
        controls: options(),
        videoUrl: bad,
      }),
      { code: "MEDIA_UNAVAILABLE" },
    );
  }
});
test("cancellation is best effort for ongoing URL downloads and never claims published deletion", async () => {
  assert.equal(
    (await client.cancelDownload("tt-access-a", "v_pub_url~v2-1.cancel"))
      .accepted,
    true,
  );
  assert.equal(
    (await client.postStatus("tt-access-a", "v_pub_url~v2-1.cancel"))
      .failReason,
    "publish_cancelled",
  );
  await assert.rejects(
    client.cancelDownload("tt-access-a", "v_pub_url~v2-1.public"),
    { code: "PUBLISH_NOT_CANCELLABLE" },
  );
});
test("guard runs before every HTTP and explicit mock configuration cannot silently select live hosts", async () => {
  let guarded = 0;
  const guardClient = new TikTokClient({
    ...config,
    mockoonEnabled: true,
    mockoonBaseUrl: mock.origin,
    beforeRequest: async () => {
      guarded++;
      throw new SecurityError("STALE_CREDENTIALS", 409, "Access changed.");
    },
  });
  await assert.rejects(guardClient.verifiedUser("tt-access-a"), {
    code: "STALE_CREDENTIALS",
  });
  assert.equal(guarded, 1);
  for (const patch of [
    { mockoonEnabled: true },
    { mockoonBaseUrl: mock.origin },
    { mockoonEnabled: true, mockoonBaseUrl: "http://remote.example" },
    { redirectUri: "http://launchpad.test/callback" },
    { redirectUri: config.redirectUri + "?x=1" },
  ])
    assert.throws(() => new TikTokClient({ ...config, ...patch }), {
      code: "INVALID_CONFIG",
    });
});
test("local quota guards enforce six init and thirty status requests per access-token window", async () => {
  for (let i = 0; i < 6; i++)
    await assert.rejects(
      client.initVideo("tt-local-init-quota", {
        caption: "fixture-ambiguous",
        controls: options(),
        videoUrl: url(),
      }),
      { code: "INVALID_PROVIDER_RESPONSE" },
    );
  await assert.rejects(
    client.initVideo("tt-local-init-quota", {
      caption: "fixture-ambiguous",
      controls: options(),
      videoUrl: url(),
    }),
    { code: "PROVIDER_RATE_LIMITED" },
  );
  for (let i = 0; i < 30; i++)
    await client.postStatus("tt-local-status-quota", "v_pub_url~v2-1.private");
  await assert.rejects(
    client.postStatus("tt-local-status-quota", "v_pub_url~v2-1.private"),
    { code: "PROVIDER_RATE_LIMITED" },
  );
});
