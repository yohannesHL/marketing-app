import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { YouTubeClient, YOUTUBE_SCOPES, YOUTUBE_CHUNK_BYTES, validateShortsMedia } from "../../apps/web/src/server/providers/youtube";
import { startMockoon } from "../support/mockoon";

let mock: Awaited<ReturnType<typeof startMockoon>>;
let client: YouTubeClient;
const clock = () => new Date("2026-10-13T12:00:00Z");
const verifier = "v".repeat(43);
const config = { clientId: "yt-client", clientSecret: "fixture-yt-secret",
  redirectUri: "https://launchpad.test/api/connections/youtube/callback", now: clock };
before(async () => {
  mock = await startMockoon("tests/mockoon/youtube.json");
  client = new YouTubeClient({ ...config, mockoonEnabled: true, mockoonBaseUrl: mock.origin });
});
after(async () => { await mock?.stop(); });

test("YouTube OAuth uses independent least scopes, offline S256 and verified userinfo instead of JWT claims", async () => {
  const live = new YouTubeClient(config);
  const url = new URL(live.authorizationUrl({ state: "session-bound-state", codeChallenge: "c".repeat(43) }));
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("redirect_uri"), config.redirectUri);
  assert.equal(url.searchParams.get("state"), "session-bound-state");
  assert.equal(url.searchParams.get("scope"), YOUTUBE_SCOPES.join(" "));
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("scope")?.includes("adwords"), false);
  const grant = await client.exchangeCode({ code: "success", codeVerifier: verifier });
  assert.equal(grant.providerUserId, "google-sub-a");
  assert.equal(grant.accessToken, "yt-access-a");
  assert.equal(grant.refreshToken, "yt-refresh-a");
  assert.equal(grant.expiresAt.toISOString(), "2026-10-13T13:00:00.000Z");
  assert.deepEqual(grant.scopes, [...YOUTUBE_SCOPES]);
});

test("offline renewal verifies the original subject, rotates tokens and never borrows another identity's refresh token", async () => {
  await assert.rejects(client.exchangeCode({ code: "no-refresh", codeVerifier: verifier }), { code: "RECONNECT_REQUIRED" });
  const owned = { providerUserId: "google-sub-a", refreshToken: "yt-refresh-a" };
  assert.equal((await client.exchangeCode({ code: "no-refresh", codeVerifier: verifier, previous: owned })).refreshToken, owned.refreshToken);
  await assert.rejects(client.exchangeCode({ code: "wrong-subject", codeVerifier: verifier, previous: owned }), { code: "PROVIDER_IDENTITY_MISMATCH" });
  const refreshed = await client.renewVerified({ ...owned, scopes: [...YOUTUBE_SCOPES] });
  assert.equal(refreshed.refreshToken, "yt-refresh-rotated");
  const retained = await client.renewVerified(refreshed);
  assert.equal(retained.refreshToken, "yt-refresh-rotated");
  for (const [code, expected] of [["missing-scope", "MISSING_PERMISSION"], ["bad-expiry", "INVALID_PROVIDER_RESPONSE"],
    ["missing-sub", "INVALID_PROVIDER_RESPONSE"], ["revoked", "RECONNECT_REQUIRED"]]) {
    await assert.rejects(client.exchangeCode({ code, codeVerifier: verifier }), { code: expected });
  }
});

test("channel discovery follows short/empty pages and verifies channel identity rather than Google subject or Ads access", async () => {
  const channels = await client.discoverChannels("yt-pagination");
  assert.deepEqual(channels.map((channel) => [channel.id, channel.title]), [["UCfixtureBrandA", "Brand channel A"], ["UCfixturePersonalA", "Personal channel A"]]);
  assert.equal((await client.verifyChannel("yt-access-a", "UCfixtureBrandA")).id, "UCfixtureBrandA");
  await assert.rejects(client.verifyChannel("yt-access-a", "google-sub-a"), { code: "CHANNEL_MISMATCH" });
  await assert.rejects(client.verifyChannel("yt-access-b", "UCfixtureBrandA"), { code: "CHANNEL_MISMATCH" });
  await assert.rejects(client.discoverChannels("ads-only-token"), { code: "MISSING_PERMISSION" });
});

const media = { mimeType: "video/mp4", byteLength: YOUTUBE_CHUNK_BYTES + 7, width: 1080, height: 1920, durationSeconds: 180, rotationDegrees: 0 };
const content = { media, title: "Reviewed fixture Short", description: "Synthetic media, no live publication",
  categoryId: "22", privacyStatus: "private" as const, selfDeclaredMadeForKids: false, containsSyntheticMedia: true };
test("trusted decoded media must be square/portrait and no longer than three minutes before starting an upload", () => {
  assert.equal(validateShortsMedia(media).displayWidth, 1080);
  assert.equal(validateShortsMedia({ ...media, width: 1920, height: 1080, rotationDegrees: -90 }).displayWidth, 1080);
  for (const patch of [{ durationSeconds: 180.1 }, { durationSeconds: 0 }, { width: 1920, height: 1080 },
    { mimeType: "image/png" }, { byteLength: 0 }, { rotationDegrees: 45 }, { width: 0 }]) {
    assert.throws(() => validateShortsMedia({ ...media, ...patch }), { code: "INVALID_MEDIA" });
  }
});

test("resumable upload saves a validated private session, probes progress and sends exact 256KiB/final byte ranges", async () => {
  const session = await client.startResumable("yt-access-a", "UCfixtureBrandA", content);
  assert.equal(new URL(session.sessionUrl).origin, mock.origin);
  assert.equal(session.totalBytes, media.byteLength);
  assert.deepEqual(await client.probeUpload("yt-access-a", session.sessionUrl, { totalBytes: media.byteLength, channelId: "UCfixtureBrandA" }),
    { state: "UPLOADING", nextOffset: 0 });
  assert.deepEqual(await client.uploadChunk("yt-access-a", session.sessionUrl, {
    offset: 0, totalBytes: media.byteLength, mimeType: media.mimeType, channelId: "UCfixtureBrandA", bytes: new Uint8Array(YOUTUBE_CHUNK_BYTES),
  }), { state: "UPLOADING", nextOffset: YOUTUBE_CHUNK_BYTES });
  assert.deepEqual(await client.probeUpload("yt-access-a", session.sessionUrl, { totalBytes: media.byteLength, channelId: "UCfixtureBrandA" }),
    { state: "UPLOADING", nextOffset: YOUTUBE_CHUNK_BYTES });
  assert.deepEqual(await client.uploadChunk("yt-access-a", session.sessionUrl, {
    offset: YOUTUBE_CHUNK_BYTES, totalBytes: media.byteLength, mimeType: media.mimeType, channelId: "UCfixtureBrandA", bytes: new Uint8Array(7),
  }), { state: "UPLOADED", videoId: "ytVideoA001" });
});

test("readback distinguishes processing, scheduled and confirmed visibility and rejects another channel's video", async () => {
  assert.equal((await client.videoStatus("yt-access-a", "processingVideo", "UCfixtureBrandA")).state, "PROCESSING");
  assert.equal((await client.videoStatus("yt-access-a", "scheduledVideo", "UCfixtureBrandA")).state, "SCHEDULED");
  assert.equal((await client.videoStatus("yt-access-a", "publishedVideo", "UCfixtureBrandA")).state, "PUBLISHED");
  assert.equal((await client.videoStatus("yt-access-a", "failedVideo", "UCfixtureBrandA")).state, "FAILED");
  await assert.rejects(client.videoStatus("yt-access-a", "wrongChannelVideo", "UCfixtureBrandA"), { code: "CHANNEL_MISMATCH" });
  await assert.rejects(client.videoStatus("yt-access-a", "missingVideo", "UCfixtureBrandA"), { code: "VIDEO_NOT_FOUND" });
  assert.deepEqual(await client.reconcile("yt-access-a", "UCfixtureBrandA", {}), { state: "UNRESOLVED" });
  const known = await client.reconcile("yt-access-a", "UCfixtureBrandA", { videoId: "publishedVideo" });
  assert.equal(known.state, "KNOWN");
  if (known.state === "KNOWN") assert.equal(known.video.state, "PUBLISHED");
});

test("native reschedule and cancellation preserve mutable status, clear publishAt remotely and verify readback", async () => {
  const moved = await client.updateSchedule("yt-access-a", "editableVideo", "UCfixtureBrandA", "2026-10-15T15:00:00Z");
  assert.equal(moved.status.publishAt, "2026-10-15T15:00:00.000Z");
  assert.equal(moved.state, "SCHEDULED");
  const cancelled = await client.cancelSchedule("yt-access-a", "editableVideo", "UCfixtureBrandA");
  assert.deepEqual(cancelled.status, { privacyStatus: "private", embeddable: true,
    publicStatsViewable: false, license: "youtube", selfDeclaredMadeForKids: false, containsSyntheticMedia: true });
  assert.equal(cancelled.state, "READY");
  assert.equal((await client.cancelSchedule("yt-access-a", "editableVideo", "UCfixtureBrandA")).status.publishAt, undefined);
  await assert.rejects(client.updateSchedule("yt-access-a", "publishedVideo", "UCfixtureBrandA", "2026-10-15T15:00:00Z"), { code: "INVALID_SCHEDULE" });
  await assert.rejects(client.updateSchedule("yt-access-a", "editableVideo", "UCfixtureBrandA", "2026-10-12T15:00:00Z"), { code: "INVALID_SCHEDULE" });
  await assert.rejects(client.startResumable("yt-access-a", "UCfixtureBrandA", { ...content, privacyStatus: "public", publishAt: "2026-10-14T12:00:00Z" }), { code: "INVALID_SCHEDULE" });
});

test("upload receipts with missing or mismatched channel identity remain uncertain after bytes were submitted", async () => {
  for (const [id, code] of [["malformed-final", "PROVIDER_OUTCOME_UNKNOWN"], ["mismatched-final", "CHANNEL_MISMATCH"]]) {
    await assert.rejects(client.uploadChunk("yt-access-a", session(id), {
      offset: YOUTUBE_CHUNK_BYTES, totalBytes: media.byteLength, mimeType: media.mimeType, channelId: "UCfixtureBrandA", bytes: new Uint8Array(7),
    }), { code, outcomeUnknown: true });
  }
});

function session(id: string) { return `${mock.origin}/upload/youtube/v3/videos?uploadType=resumable&upload_id=${id}`; }
test("untrusted resumable locations, redirects, invalid ranges and expired sessions never produce success or another upload", async () => {
  for (const title of ["unsafe-location", "missing-location"]) {
    await assert.rejects(client.startResumable("yt-access-a", "UCfixtureBrandA", { ...content, title }),
      { code: "PROVIDER_OUTCOME_UNKNOWN", outcomeUnknown: true });
  }
  for (const id of ["expired-session", "bad-range", "redirect-session"]) {
    await assert.rejects(client.reconcile("yt-access-a", "UCfixtureBrandA", { sessionUrl: session(id), totalBytes: media.byteLength }),
      (error: unknown) => !!error && typeof error === "object" && "code" in error &&
        ["UPLOAD_SESSION_EXPIRED", "PROVIDER_OUTCOME_UNKNOWN", "INVALID_PROVIDER_RESPONSE"].includes(String(error.code)));
  }
  assert.deepEqual(await client.reconcile("yt-access-a", "UCfixtureBrandA", { sessionUrl: session("completed-session"), totalBytes: media.byteLength }),
    { state: "UPLOADED", videoId: "ytVideoA001" });
  for (const url of ["https://attacker.test/upload/youtube/v3/videos?uploadType=resumable&upload_id=x", `${mock.origin}/other?uploadType=resumable&upload_id=x`,
    `${session("fixture-session-a")}#access_token=secret`]) {
    await assert.rejects(client.probeUpload("yt-access-a", url, { totalBytes: media.byteLength, channelId: "UCfixtureBrandA" }), { code: "INVALID_UPLOAD_SESSION" });
  }
  await assert.rejects(client.uploadChunk("yt-access-a", session("fixture-session-a"), {
    offset: 0, totalBytes: media.byteLength, mimeType: media.mimeType, bytes: new Uint8Array(7), channelId: "UCfixtureBrandA",
  }), { code: "INVALID_UPLOAD_CHUNK" });
});

test("timeouts and failed mutations are uncertain, quota errors are actionable and provider payloads stay masked", async () => {
  const fast = new YouTubeClient({ ...config, mockoonEnabled: true, mockoonBaseUrl: mock.origin, requestTimeoutMs: 1000 });
  for (const [id, code, sdk] of [["timeout-session", "PROVIDER_OUTCOME_UNKNOWN", fast], ["failed-session", "PROVIDER_OUTCOME_UNKNOWN", client],
    ["quota-session", "PROVIDER_QUOTA_EXCEEDED", client]] as const) {
    await assert.rejects(sdk.uploadChunk("yt-access-a", session(id), {
      offset: YOUTUBE_CHUNK_BYTES, totalBytes: media.byteLength, mimeType: media.mimeType, bytes: new Uint8Array(7), channelId: "UCfixtureBrandA",
    }), (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === code &&
      !String(error).includes("private-provider-secret") && !String(error).includes(mock.origin));
  }
  await assert.rejects(client.deleteVideo("yt-access-a", "wrongChannelVideo", "UCfixtureBrandA"), { code: "CHANNEL_MISMATCH" });
  await assert.rejects(client.deleteVideo("yt-access-a", "missingVideo", "UCfixtureBrandA"), { code: "VIDEO_NOT_FOUND" });
  assert.deepEqual(await client.deleteVideo("yt-access-a", "editableVideo", "UCfixtureBrandA"), { deleted: true });
});

test("mock overrides require explicit loopback configuration and native scheduling rejects invalid calendar dates", async () => {
  for (const patch of [{ mockoonBaseUrl: mock.origin }, { mockoonEnabled: true, mockoonBaseUrl: "https://attacker.test" },
    { redirectUri: "http://remote.test/callback" }, { redirectUri: "https://launchpad.test/callback#secret" }]) {
    assert.throws(() => new YouTubeClient({ ...config, ...patch }), { code: "INVALID_CONFIG" });
  }
  await assert.rejects(client.updateSchedule("yt-access-a", "editableVideo", "UCfixtureBrandA", "2027-02-31T12:00:00Z"), { code: "INVALID_SCHEDULE" });
});

test("the durable authorization guard runs before every HTTP request and can stop a stale grant between token exchange and userinfo", async () => {
  const stale = Object.assign(new Error("The authorization changed."), { code: "STALE_CREDENTIALS" });
  let checks = 0;
  const guarded = new YouTubeClient({ ...config, mockoonEnabled: true, mockoonBaseUrl: mock.origin,
    beforeRequest: async () => { if (++checks === 2) throw stale; } });
  await assert.rejects(guarded.exchangeCode({ code: "success", codeVerifier: verifier }), (error: unknown) => error === stale);
  assert.equal(checks, 2);
});

test("one stateless client isolates two channel tokens and never accepts the other channel's final video", async () => {
  const second = await client.startResumable("yt-access-b", "UCfixtureChannelB", content);
  assert.equal(second.channelId, "UCfixtureChannelB");
  assert.equal(new URL(second.sessionUrl).searchParams.get("upload_id"), "fixture-session-b");
  await assert.rejects(client.startResumable("yt-access-b", "UCfixtureBrandA", content), { code: "CHANNEL_MISMATCH" });
  assert.deepEqual(await client.uploadChunk("yt-access-b", second.sessionUrl, {
    offset: 0, totalBytes: media.byteLength, mimeType: media.mimeType, bytes: new Uint8Array(YOUTUBE_CHUNK_BYTES), channelId: "UCfixtureChannelB",
  }), { state: "UPLOADING", nextOffset: YOUTUBE_CHUNK_BYTES });
  assert.deepEqual(await client.uploadChunk("yt-access-b", second.sessionUrl, {
    offset: YOUTUBE_CHUNK_BYTES, totalBytes: media.byteLength, mimeType: media.mimeType, bytes: new Uint8Array(7), channelId: "UCfixtureChannelB",
  }), { state: "UPLOADED", videoId: "ytVideoB001" });
  assert.equal((await client.videoStatus("yt-access-b", "ytVideoB001", "UCfixtureChannelB")).state, "PUBLISHED");
  await assert.rejects(client.videoStatus("yt-access-a", "ytVideoB001", "UCfixtureBrandA"), { code: "CHANNEL_MISMATCH" });
  assert.equal((await client.verifyChannel("yt-access-a", "UCfixtureBrandA")).id, "UCfixtureBrandA");
});
test("actual OAuth token503 is retryable only for reusable refresh, while code exchange and redirects stay closed", async () => {
  await assert.rejects(client.renewVerified({ providerUserId: "google-sub-a", refreshToken: "yt-refresh-503", scopes: [...YOUTUBE_SCOPES] }),
    (error: unknown) => error instanceof Error && "retryable" in error && error.retryable === true && "outcomeUnknown" in error && error.outcomeUnknown === false);
  await assert.rejects(client.exchangeCode({ code: "code-503", codeVerifier: verifier }),
    (error: unknown) => error instanceof Error && "retryable" in error && error.retryable === false);
  let requests = 0;
  const guarded = new YouTubeClient({ ...config, mockoonEnabled: true, mockoonBaseUrl: mock.origin, beforeRequest: async () => { requests++; } });
  await assert.rejects(guarded.renewVerified({ providerUserId: "google-sub-a", refreshToken: "yt-refresh-redirect", scopes: [...YOUTUBE_SCOPES] }));
  assert.equal(requests, 1);
});
