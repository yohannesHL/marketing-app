import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { createHash } from "node:crypto";
import {
  XClient,
  X_SCOPES,
  XError,
  validateXText,
  validateXMedia,
  xCostEstimate,
  type XPriceSchedule,
} from "../../apps/web/src/server/providers/x";
import { SecurityError } from "../../apps/web/src/server/security/errors";
import { startMockoon } from "../support/mockoon";
let mock: Awaited<ReturnType<typeof startMockoon>>, client: XClient;
const now = () => new Date("2026-10-13T12:00:00Z");
const verifier = "a".repeat(64),
  challenge = createHash("sha256").update(verifier).digest("base64url");
const config = {
  clientId: "x-client",
  clientSecret: "fixture-x-secret",
  redirectUri: "https://launchpad.test/api/connections/x/callback",
  now,
};
const image = {
  mime: "image/png",
  bytes: 8,
  width: 64,
  height: 64,
  durationMs: null,
};
const video = {
  mime: "video/mp4",
  bytes: 8,
  width: 720,
  height: 1280,
  durationMs: 1000,
  metadata: { videoCodec: "h264", fps: 30 },
};
const post = (text: string, mediaIds: string[] = []) => ({
  text,
  mediaIds,
  madeWithAi: false,
  paidPartnership: false,
});
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
before(async () => {
  mock = await startMockoon("tests/mockoon/x.json");
  client = new XClient({
    ...config,
    mockoonBaseUrl: mock.origin,
    mockoonEnabled: true,
  });
});
after(async () => {
  await mock?.stop();
});
test("confidential OAuth2 S256 requests offline media/user scopes and verifies actual user through me", async () => {
  const auth = new URL(
    new XClient(config).authorizationUrl({
      state: "server-bound-state",
      codeChallenge: challenge,
    }),
  );
  assert.equal(auth.origin, "https://x.com");
  assert.equal(auth.pathname, "/i/oauth2/authorize");
  assert.equal(auth.searchParams.get("scope"), X_SCOPES.join(" "));
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  assert.equal(auth.searchParams.get("code_challenge"), challenge);
  const grant = await client.exchangeCode({
    code: "success",
    codeVerifier: verifier,
  });
  assert.equal(grant.providerUserId, "1001");
  assert.equal(grant.username, "fixture_x");
  assert.equal(grant.expiresAt.toISOString(), "2026-10-13T14:00:00.000Z");
  assert.deepEqual(grant.scopes, [...X_SCOPES]);
});
test("refresh rotates credentials and rejects missing scopes, missing refresh, expired grants and changed identities", async () => {
  const grant = await client.renewVerified({
    providerUserId: "1001",
    refreshToken: "x-refresh",
  });
  assert.equal(grant.refreshToken, "x-refresh-rotated");
  assert.equal(
    (await client.renewVerified(grant)).refreshToken,
    "x-refresh-rotated",
  );
  for (const [code, error] of [
    ["missing-scope", "MISSING_PERMISSION"],
    ["no-refresh", "INVALID_PROVIDER_RESPONSE"],
    ["bad-expiry", "INVALID_PROVIDER_RESPONSE"],
    ["revoked", "RECONNECT_REQUIRED"],
  ])
    await assert.rejects(
      client.exchangeCode({ code, codeVerifier: verifier }),
      { code: error },
    );
  await assert.rejects(
    client.exchangeCode({
      code: "wrong-user",
      codeVerifier: verifier,
      previous: { providerUserId: "1001" },
    }),
    { code: "PROVIDER_IDENTITY_MISMATCH" },
  );
  await assert.rejects(
    client.renewVerified({
      providerUserId: "1001",
      refreshToken: "x-refresh-other",
    }),
    { code: "PROVIDER_IDENTITY_MISMATCH" },
  );
});
test("official weighted280 validator handles URLs, NFC, CJK and complex emoji sequences", () => {
  assert.equal(validateXText("a".repeat(280)).weightedLength, 280);
  assert.equal(validateXText("漢".repeat(140)).weightedLength, 280);
  assert.equal(validateXText("👨‍👩‍👧‍👦".repeat(140)).weightedLength, 280);
  assert.equal(validateXText("cafe\u0301").text, "café");
  assert.equal(
    validateXText("https://example.com/very/long/path").weightedLength,
    23,
  );
  for (const s of ["a".repeat(281), "漢".repeat(141), ""])
    assert.throws(() => validateXText(s), { code: "INVALID_CONTENT" });
  assert.equal(validateXText("", 1).weightedLength, 0);
});
test("media validation uses inspected format codec FPS duration and current default account limits", () => {
  assert.equal(validateXMedia(image, "IMAGE"), image);
  assert.equal(validateXMedia(video, "SHORT_VIDEO"), video);
  for (const patch of [
    { bytes: 5000001 },
    { mime: "image/gif" },
    { durationMs: 100 },
  ])
    assert.throws(() => validateXMedia({ ...image, ...patch }, "IMAGE"), {
      code: "INVALID_MEDIA",
    });
  for (const patch of [
    { durationMs: 1200001 },
    { durationMs: 499 },
    { metadata: { videoCodec: "av1", fps: 30 } },
    { metadata: { videoCodec: "h264", fps: 61 } },
    { width: 31 },
  ])
    assert.throws(() => validateXMedia({ ...video, ...patch }, "SHORT_VIDEO"), {
      code: "INVALID_MEDIA",
    });
  assert.equal(xCostEstimate("Fixture text", "TEXT", [], prices), 50000);
  assert.equal(
    xCostEstimate("https://example.com", "TEXT", [], prices),
    235000,
  );
  assert.equal(xCostEstimate("Video", "SHORT_VIDEO", [video], prices), 54000);
});
test("v2 simple image uploads actual base64 media and records exact ID/key/expiry", async () => {
  const receipt = await client.uploadImage(
    "x-access",
    image,
    Buffer.from("xxxxxxxx"),
  );
  assert.equal(receipt.id, "5001");
  assert.equal(receipt.mediaKey, "3_5001");
  assert.equal(receipt.state, "succeeded");
  assert.equal(receipt.expiresAt?.toISOString(), "2026-10-14T12:00:00.000Z");
  await assert.rejects(
    client.uploadImage("x-access", image, Buffer.from("short")),
    { code: "INVALID_MEDIA" },
  );
});
test("video uses dedicated INIT/APPEND/FINALIZE and STATUS paths with processing backoff", async () => {
  const init = await client.initVideo("x-access", video);
  assert.equal(init.id, "5002");
  await client.appendVideo("x-access", init.id, 0, Buffer.from("xxxxxxxx"));
  const final = await client.finalizeVideo("x-access", init.id);
  assert.equal(final.state, "pending");
  assert.equal(final.checkAfterMs, 2000);
  const status = await client.mediaStatus("x-access", init.id);
  assert.equal(status.state, "in_progress");
  await fetch(mock.origin + "/fixture/video-ready", { method: "POST" });
  assert.equal(
    (await client.mediaStatus("x-access", init.id)).state,
    "succeeded",
  );
  await assert.rejects(
    client.appendVideo("x-access", "5002", -1, Buffer.from("x")),
    { code: "INVALID_MEDIA" },
  );
});
test("create always sends text and explicit disclosures; returned ID requires author readback", async () => {
  const receipt = await client.createPost("x-access", post("Fixture text"));
  assert.equal(receipt.id, "6001");
  const read = await client.post("x-access", receipt.id, "1001");
  assert.equal(read.text, "Fixture text");
  assert.deepEqual(read.mediaKeys, []);
  await assert.rejects(client.post("x-access", "6999", "1001"), {
    code: "PROVIDER_IDENTITY_MISMATCH",
  });
  const disclosure = await client.createPost("x-access", {
    ...post("Fixture disclosure"),
    madeWithAi: true,
    paidPartnership: true,
  });
  assert.equal(disclosure.id, "6004");
  const mediaOnly = await client.createPost("x-access", post("", ["5001"]));
  assert.equal(mediaOnly.id, "6008");
  assert.equal((await client.post("x-access", mediaOnly.id, "1001")).text, "");
  await assert.rejects(
    client.createPost("x-access", post("Too many", ["1", "2", "3", "4", "5"])),
    {
      code: "INVALID_CONTENT",
    },
  );
});
test("credit exhaustion differs from429; ambiguous/malformed/5xx creation cannot be blindly resent", async () => {
  for (const [text, code, unknown] of [
    ["Fixture credits", "PROVIDER_CREDITS_REQUIRED", false],
    ["Fixture rate", "PROVIDER_RATE_LIMITED", false],
    ["Fixture ambiguous", "INVALID_PROVIDER_RESPONSE", true],
    ["Fixture server", "PROVIDER_UNAVAILABLE", true],
    ["Fixture partial", "PROVIDER_REQUEST_FAILED", true],
  ] as const)
    await assert.rejects(client.createPost("x-access", post(text)), (error) => {
      assert.ok(error instanceof XError);
      assert.equal(error.code, code);
      assert.equal(error.outcomeUnknown, unknown);
      assert.doesNotMatch(JSON.stringify(error), /fixture-upstream-secret/);
      if (text === "Fixture rate") assert.equal(error.retryAfterMs, 60000);
      return true;
    });
});
test("delete uses only known IDs and returns confirmed deleted flag", async () => {
  assert.deepEqual(await client.deletePost("x-access", "6001"), {
    deleted: true,
  });
  await assert.rejects(client.post("x-access", "6001", "1001"), {
    code: "POST_NOT_FOUND",
  });
  await assert.rejects(client.deletePost("x-access", "https://attacker.test"), {
    code: "INVALID_PROVIDER_RESPONSE",
  });
});
test("every billable send is guarded and live writes require explicit billing callback with no mock fallback", async () => {
  let guards = 0;
  const operations: string[] = [];
  const guarded = new XClient({
    ...config,
    mockoonEnabled: true,
    mockoonBaseUrl: mock.origin,
    beforeRequest: async () => {
      guards++;
    },
    beforeBillableRequest: async (op) => {
      operations.push(op);
    },
  });
  await guarded.verifiedUser("x-access", "1001");
  assert.equal(guards, 2);
  assert.deepEqual(operations, ["USER_READ"]);
  const revoked = new XClient({
    ...config,
    mockoonEnabled: true,
    mockoonBaseUrl: mock.origin,
    beforeRequest: async () => {
      throw new SecurityError("STALE_CREDENTIALS", 409, "Grant changed.");
    },
  });
  await assert.rejects(revoked.verifiedUser("x-access"), {
    code: "STALE_CREDENTIALS",
  });
  await assert.rejects(
    new XClient(config).createPost("no-live-send", post("Fixture text")),
    { code: "INVALID_CONFIG" },
  );
  for (const patch of [
    { mockoonBaseUrl: mock.origin },
    { mockoonEnabled: true },
    { mockoonEnabled: true, mockoonBaseUrl: "https://attacker.test" },
  ])
    assert.throws(() => new XClient({ ...config, ...patch }), {
      code: "INVALID_CONFIG",
    });
});

for (const operation of ["USER_READ", "POST_READ", "MEDIA_STATUS"] as const) {
  test(`live ${operation} without a funding callback rejects before any network request`, async () => {
    const previous = globalThis.fetch; let requests = 0;
    // This guard regression must never reach a real provider, even before the fix.
    globalThis.fetch = async () => { requests++; throw new Error("Blocked synthetic network boundary"); };
    try {
      const sdk = new XClient(config);
      assert.equal(sdk.mode, "live");
      await assert.rejects(operation === "USER_READ" ? sdk.verifiedUser("synthetic-access", "1001") :
        operation === "POST_READ" ? sdk.post("synthetic-access", "6001", "1001") :
          sdk.mediaStatus("synthetic-access", "5001"), { code: "INVALID_CONFIG" });
      assert.equal(requests, 0);
    } finally { globalThis.fetch = previous; }
  });
}
