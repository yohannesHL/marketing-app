import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { MetaAdsClient, MetaProviderError, META_ADS_SCOPES } from "../../apps/web/src/server/providers/metaAds";
import { verifyMetaSignedRequest } from "../../apps/web/src/server/providers/metaSignedRequests";

let mockoon: ChildProcess;
let origin: string;
let client: MetaAdsClient;
const now = () => new Date("2026-10-13T12:00:00Z");
const config = {
  appId: "123", appSecret: "fixture-app-secret", configId: "456",
  redirectUri: "https://launchpad.test/api/connections/meta/callback", now,
};

before(async () => {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  origin = `http://127.0.0.1:${port}`;
  mockoon = spawn(process.execPath, ["node_modules/@mockoon/cli/bin/run.js", "start",
    "--data", "tests/mockoon/meta-ads.json", "--port", String(port),
    "--hostname", "127.0.0.1", "--disable-log-to-file", "--disable-admin-api"],
    { stdio: "ignore" });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (mockoon.exitCode !== null) throw new Error("Meta HTTP fixture exited before readiness.");
    try {
      if ((await fetch(`${origin}/health`)).ok) {
        client = new MetaAdsClient({ ...config, testBaseUrl: origin });
        return;
      }
    } catch { /* The isolated HTTP fixture is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Meta HTTP fixture did not become ready.");
});

after(async () => {
  if (mockoon && mockoon.exitCode === null) {
    const exited = once(mockoon, "exit");
    mockoon.kill("SIGTERM");
    await exited;
  }
});

test("Business Login authorization carries the configuration and exact state without assuming PKCE", () => {
  const live = new MetaAdsClient(config);
  const url = new URL(live.authorizationUrl("bound-state"));
  assert.equal(url.origin, "https://www.facebook.com");
  assert.equal(url.pathname, "/v26.0/dialog/oauth");
  assert.equal(url.searchParams.get("config_id"), "456");
  assert.equal(url.searchParams.get("state"), "bound-state");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("redirect_uri"), config.redirectUri);
  assert.equal(url.searchParams.has("scope"), false);
  assert.equal(url.searchParams.has("code_challenge"), false);
  assert.equal(live.pkce, false);
  assert.throws(() => new MetaAdsClient({ ...config, testBaseUrl: "https://attacker.test" }),
    { code: "INVALID_PROVIDER_CONFIG" });
  assert.throws(() => new MetaAdsClient({ ...config, marketingVersion: "v24.0" }),
    { code: "INVALID_PROVIDER_CONFIG" });
});

test("real HTTP code and long-lived exchanges verify identity and use actual expiry", async () => {
  const grant = await client.exchangeCode("success", "1001");
  assert.equal(grant.accessToken, "long_success");
  assert.equal(grant.providerUserId, "1001");
  assert.equal(grant.externalGrantId, "1001");
  assert.equal(grant.displayName, "Verified customer");
  assert.equal(grant.tokenType, "USER");
  assert.deepEqual(grant.scopes, META_ADS_SCOPES);
  assert.equal(grant.expiresAt?.toISOString(), "2026-10-13T13:00:00.000Z");
  assert.equal("refreshToken" in grant, false);
  assert.equal((await client.exchangeCode("zeroexpiry")).expiresAt, null);
});

test("missing permissions, invalid app/type and identity mismatch cannot become usable grants", async () => {
  for (const scenario of ["invalid", "wrong-app", "wrong-type", "expired", "data-expired", "revoked"]) {
    await assert.rejects(client.exchangeCode(scenario), { code: "RECONNECT_REQUIRED" });
  }
  await assert.rejects(client.exchangeCode("missing"), { code: "MISSING_PERMISSION" });
  await assert.rejects(client.exchangeCode("wrong-subject"), { code: "SUBJECT_MISMATCH" });
  await assert.rejects(client.exchangeCode("success", "different-subject"), { code: "SUBJECT_MISMATCH" });
});

test("pagination continues through short and empty pages and exposes current account tasks", async () => {
  const accounts = await client.discoverAccounts("long_success");
  assert.deepEqual(accounts.map((a) => a.externalId), ["111", "222", "333"]);
  assert.equal(accounts[0].canManage, true);
  assert.equal(accounts[1].canManage, false);
  assert.equal(accounts[2].canManage, false);
  assert.equal(accounts[0].graphId, "act_111");
  assert.equal(accounts[0].currency, "GBP");
  assert.equal(accounts[0].timezone, "Europe/London");
  assert.deepEqual((await client.readAccount("long_success", "act_111")).userTasks, ["ADVERTISE", "ANALYZE"]);
  await assert.rejects(client.discoverAccounts("unsafe-next"), { code: "INVALID_PROVIDER_RESPONSE" });
  await assert.rejects(client.discoverAccounts("malformed-next"), (error: unknown) => {
    assert.ok(error instanceof MetaProviderError);
    assert.equal(error.code, "INVALID_PROVIDER_RESPONSE");
    assert.equal(String(error).includes("embedded-secret"), false);
    return true;
  });
  await assert.rejects(client.discoverAccounts("repeated"), { code: "INVALID_PROVIDER_RESPONSE" });
});

test("provider errors remain structured without reflecting credentials or provider messages", async () => {
  for (const [token, code, retryable] of [["denied", "MISSING_PERMISSION", false],
    ["throttle", "PROVIDER_REJECTED", true]] as const) {
    await assert.rejects(client.discoverAccounts(token), (error: unknown) => {
      assert.ok(error instanceof MetaProviderError);
      assert.equal(error.code, code);
      assert.equal(error.retryable, retryable);
      assert.equal(JSON.stringify(error).includes("sensitive"), false);
      assert.equal(String(error).includes("sensitive"), false);
      return true;
    });
  }
});

test("HTTP campaign validation and creation stay paused and cleanup checks account ownership/status", async () => {
  const input = { name: "Verification campaign" };
  assert.deepEqual(await client.validatePausedCampaign("long_success", "111", input), { success: true });
  assert.deepEqual(await client.createPausedCampaign("long_success", "111", input), { id: "9001" });
  const campaign = await client.readCampaign("long_success", "9001", "111");
  assert.equal(campaign.status, "PAUSED");
  assert.equal(campaign.objective, "OUTCOME_TRAFFIC");
  assert.deepEqual(await client.removeCampaign("long_success", "9001", "111"), { success: true });
  await assert.rejects(client.removeCampaign("active-campaign", "9001", "111"), { code: "CAMPAIGN_NOT_PAUSED" });
  await assert.rejects(client.removeCampaign("wrong-campaign-account", "9001", "111"), { code: "INVALID_PROVIDER_RESPONSE" });
  await assert.rejects(client.createPausedCampaign("long_success", "222", input), { code: "ACCOUNT_UNAVAILABLE" });
  await assert.rejects(client.createPausedCampaign("long_success", "333", input), { code: "ACCOUNT_UNAVAILABLE" });
});

function signed(data: unknown, secret = config.appSecret) {
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  return `${createHmac("sha256", secret).update(payload).digest("base64url")}.${payload}`;
}

test("Meta callbacks verify HMAC over the original encoded payload and accept authenticated retries", () => {
  const value = signed({ algorithm: "HMAC-SHA256", user_id: "1001", issued_at: 1, expires: 0 });
  assert.equal(verifyMetaSignedRequest(value, config.appSecret).userId, "1001");
  assert.equal(verifyMetaSignedRequest(value, config.appSecret).issuedAt?.getTime(), 1000);
  for (const invalid of [value + ".extra", value.replace(/^./, "!"),
    signed({ algorithm: "SHA256", user_id: "1001" }),
    signed({ algorithm: "HMAC-SHA256", user_id: "" }),
    signed({ algorithm: "HMAC-SHA256", user_id: 1001 }),
    signed({ algorithm: "HMAC-SHA256", user_id: "1001", issued_at: "fake" }),
    signed({ algorithm: "HMAC-SHA256", user_id: "1001" }, "wrong-secret")]) {
    assert.throws(() => verifyMetaSignedRequest(invalid, config.appSecret), { code: "INVALID_SIGNED_REQUEST" });
  }
  const payload = value.split(".")[1];
  const decodedSignature = createHmac("sha256", config.appSecret)
    .update(Buffer.from(payload, "base64url")).digest("base64url");
  assert.throws(() => verifyMetaSignedRequest(`${decodedSignature}.${payload}`, config.appSecret),
    { code: "INVALID_SIGNED_REQUEST" });
});
