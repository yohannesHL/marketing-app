import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import {
  GoogleAdsClient,
  GOOGLE_ADS_SCOPES,
  googlePkceChallenge,
} from "../../apps/web/src/server/providers/googleAds";
import { ProviderHttpError } from "../../apps/web/src/server/providers/providerHttp";

let mockoon: ChildProcess;
let origin: string;
let client: GoogleAdsClient;
const verifier = "v".repeat(64);
const config = {
  clientId: "mock-google-client",
  clientSecret: "mock-client-secret",
  redirectUri: "https://launchpad.test/api/connections/google/callback",
};
const previous = { providerUserId: "google-sub-1", refreshToken: "mock-refresh" };

before(async () => {
  // The test starts the actual Mockoon CLI; no fetch monkeypatch or toy HTTP server.
  const require = createRequire(import.meta.url);
  const executable = process.env.MOCKOON_CLI_PATH ?? resolve(dirname(require.resolve("@mockoon/cli/package.json")), "bin/run.js");
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  origin = `http://127.0.0.1:${port}`;
  mockoon = spawn(process.execPath, [executable, "start", "--data", resolve("tests/mockoon/google-ads.json"),
    "--port", String(port), "--hostname", "127.0.0.1", "--disable-log-to-file", "--disable-admin-api"], { stdio: "ignore" });
  let spawnError: Error | undefined;
  mockoon.on("error", (error) => { spawnError = error; });
  const deadline = Date.now() + 15_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (spawnError || mockoon.exitCode !== null) throw new Error("Mockoon failed to start. Install @mockoon/cli and check the fixture.");
    try { ready = (await fetch(`${origin}/health`)).ok; } catch { /* Startup is asynchronous. */ }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, "Mockoon must be running; a missing fixture server cannot pass as a skip.");
  client = new GoogleAdsClient({ ...config, mockoonBaseUrl: origin, mockoonEnabled: true },
    () => new Date("2026-10-13T09:00:00Z"));
});

after(async () => {
  if (!mockoon || mockoon.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    mockoon.once("exit", () => resolve());
    mockoon.kill("SIGTERM");
  });
});

test("authorization requests offline Google Ads access using fixed hosts and S256", () => {
  const live = new GoogleAdsClient(config);
  const url = new URL(live.authorizationUrl({ state: "opaque-session-state", codeChallenge: googlePkceChallenge(verifier) }));
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("scope"), GOOGLE_ADS_SCOPES.join(" "));
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent select_account");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), googlePkceChallenge(verifier));
  assert.equal(url.searchParams.has("client_secret"), false);
  assert.equal(url.searchParams.has("code_verifier"), false);
});

test("real Mockoon consent redirect preserves the caller's opaque state", async () => {
  const response = await fetch(client.authorizationUrl({ state: "opaque-state-123", codeChallenge: googlePkceChallenge(verifier) }), { redirect: "manual" });
  assert.equal(response.status, 302);
  const callback = new URL(response.headers.get("location")!);
  assert.equal(callback.origin + callback.pathname, config.redirectUri);
  assert.equal(callback.searchParams.get("code"), "success");
  assert.equal(callback.searchParams.get("state"), "opaque-state-123");
});

test("form-encoded code exchange verifies stable userinfo subject and expiry", async () => {
  const grant = await client.exchangeCode({ code: "success", codeVerifier: verifier });
  assert.equal(grant.providerUserId, "google-sub-1");
  assert.equal(grant.accessToken, "mock-access");
  assert.equal(grant.refreshToken, "mock-refresh");
  assert.deepEqual(grant.scopes, GOOGLE_ADS_SCOPES);
  assert.equal(grant.expiresAt.toISOString(), "2026-10-13T10:00:00.000Z");
});

test("omitted refresh token is retained only on the same verified subject", async () => {
  const grant = await client.exchangeCode({ code: "no-refresh", codeVerifier: verifier, previous });
  assert.equal(grant.refreshToken, "mock-refresh");
  await assert.rejects(client.exchangeCode({ code: "no-refresh", codeVerifier: verifier }), { code: "RECONNECT_REQUIRED" });
  await assert.rejects(client.exchangeCode({ code: "different-user", codeVerifier: verifier, previous }), { code: "PROVIDER_IDENTITY_MISMATCH" });
});

test("denied, insufficient, malformed and incomplete grants do not become connections", async () => {
  for (const [code, expected] of [
    ["denied", "CONSENT_DENIED"], ["missing-scope", "MISSING_PERMISSION"],
    ["missing-sub", "INVALID_PROVIDER_RESPONSE"], ["bad-expiry", "INVALID_PROVIDER_RESPONSE"],
  ]) await assert.rejects(client.exchangeCode({ code, codeVerifier: verifier }), { code: expected });
  await assert.rejects(client.exchangeCode({ code: "success", codeVerifier: "short" }), { code: "INVALID_OAUTH_STATE" });
});

test("refresh preserves omitted refresh token/scopes and verifies returning identity", async () => {
  const renewed = await client.refreshGrant({ ...previous, scopes: GOOGLE_ADS_SCOPES });
  assert.equal(renewed.accessToken, "refreshed-access");
  assert.equal(renewed.refreshToken, previous.refreshToken);
  assert.deepEqual(renewed.scopes, GOOGLE_ADS_SCOPES);
  await assert.rejects(client.refreshGrant({ ...previous, refreshToken: "revoked-refresh", scopes: GOOGLE_ADS_SCOPES }), { code: "RECONNECT_REQUIRED" });
  await assert.rejects(client.refreshGrant({ ...previous, refreshToken: "other-refresh", scopes: GOOGLE_ADS_SCOPES }), { code: "PROVIDER_IDENTITY_MISMATCH" });
});

test("paginated BFS distinguishes managers and preserves shared advertiser root contexts", async () => {
  const accounts = await client.discoverAccounts("mock-access");
  assert.deepEqual(accounts.map((account) => account.externalId).sort(), ["100", "101", "200", "300", "400", "500"]);
  const shared = accounts.find((account) => account.externalId === "400")!;
  assert.deepEqual(shared.contexts, [{ loginCustomerId: "100" }, { loginCustomerId: "200" }]);
  assert.equal(shared.manager, false);
  assert.equal(shared.currency, "GBP");
  assert.equal(shared.timezone, "Europe/London");
  assert.equal(shared.readiness.canWrite, "UNKNOWN");
  assert.equal(accounts.find((account) => account.externalId === "101")!.manager, true);
  assert.deepEqual(accounts.find((account) => account.externalId === "300")!.contexts, [{ loginCustomerId: null }]);
  assert.deepEqual(await client.discoverAccounts("empty-access"), []);
});

test("browser-supplied inaccessible IDs, manager accounts and unauthorized contexts are rejected", async () => {
  const selected = await client.verifyAccount("mock-access", { customerId: "400", loginCustomerId: "100" });
  assert.equal(selected.externalId, "400");
  for (const context of [
    { customerId: "999", loginCustomerId: "100" },
    { customerId: "100", loginCustomerId: null },
    { customerId: "400", loginCustomerId: null },
    { customerId: "400", loginCustomerId: "101" },
  ]) await assert.rejects(client.verifyAccount("mock-access", context), { code: "ACCOUNT_NOT_ACCESSIBLE" });
  await assert.rejects(client.verifyAccount("mock-access", { customerId: "https://attacker.test", loginCustomerId: null }), { code: "INVALID_ACCOUNT" });
});

test("campaign smoke follows pagination using the selected advertiser and root header", async () => {
  const campaigns = await client.readCampaigns("mock-access", { customerId: "400", loginCustomerId: "100" });
  assert.equal(campaigns.length, 2);
  assert.equal(campaigns[0].costMicros, "1200000");
  assert.equal(campaigns[1].externalId, "902");
  await assert.rejects(client.readCampaigns("mock-access", { customerId: "400", loginCustomerId: "200" }), { code: "PROVIDER_PERMISSION_DENIED" });
});

test("structured Ads project/role failures expose only safe codes and request IDs", async () => {
  await assert.rejects(client.discoverAccounts("project-denied"), (error: unknown) => {
    assert.ok(error instanceof ProviderHttpError);
    assert.equal(error.code, "PROJECT_ACCESS_REQUIRED");
    assert.equal(error.requestId, "fixture-request-1");
    assert.deepEqual(error.details, [{ code: "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION", field: "customer" }]);
    assert.equal(JSON.stringify(error).includes("sensitive-token-do-not-leak"), false);
    assert.equal(error.message.includes("sensitive-token-do-not-leak"), false);
    return true;
  });
  await assert.rejects(client.discoverAccounts("permission-denied"), { code: "PROVIDER_PERMISSION_DENIED" });
  await assert.rejects(client.discoverAccounts("invalid-bearer"), { code: "RECONNECT_REQUIRED" });
});

test("Mockoon override requires the explicit test flag and a clean loopback origin", () => {
  assert.throws(() => new GoogleAdsClient({ ...config, mockoonBaseUrl: origin }), { code: "INVALID_CONFIG" });
  for (const mockoonBaseUrl of ["https://example.test", "http://attacker.test", "http://localhost/path", "http://user:password@localhost", "http://localhost?token=secret"])
    assert.throws(() => new GoogleAdsClient({ ...config, mockoonBaseUrl, mockoonEnabled: true }), { code: "INVALID_CONFIG" });
});
