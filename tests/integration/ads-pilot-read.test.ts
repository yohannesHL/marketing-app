import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";

const credentials = { email: "pilot-fixture@example.test", password: "private-pilot-fixture-password" };
const outcome = { destinationId: "dedicated-google", provider: "GOOGLE", success: true,
  canRead: true, canWrite: "DISABLED" };
const ready = { mode: "mock", writesEnabled: false, success: true, partial: false,
  outcomes: [outcome] };

async function appFixture(readiness: unknown, loginStatus = 200, readinessRedirect?: string) {
  const requests: { path: string; origin?: string; cookie?: string; body: unknown }[] = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push({ path: request.url!, origin: request.headers.origin,
      cookie: request.headers.cookie, body: raw ? JSON.parse(raw) : null });
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/auth/login") {
      response.statusCode = loginStatus;
      response.setHeader("Set-Cookie", "launchpad_session=private-fixture-session; Path=/; HttpOnly; SameSite=Lax");
      response.end(JSON.stringify({ privateLoginPayload: "never-echo-login" }));
    } else if (request.url === "/api/ads/readiness") {
      if (readinessRedirect) {
        response.statusCode = 307;
        response.setHeader("Location", readinessRedirect);
      }
      response.end(JSON.stringify(readiness));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ message: "unexpected request" }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { origin: `http://127.0.0.1:${address.port}`, requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function runPilot(origin: string, args = ["--run-read-only", "--mock", "--destination", "dedicated-google"],
  environment: Record<string, string | undefined> = {}, input: unknown = credentials) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("ADS_PILOT_")) delete env[key];
  const processUnderTest = spawn(process.execPath, ["--import", "tsx", "apps/web/scripts/ads-pilot-read.ts", ...args], {
    env: { ...env, APP_ORIGIN: origin, ADS_PILOT_ALLOWLIST: JSON.stringify(["dedicated-google"]), ...environment },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  processUnderTest.stdout.on("data", (chunk) => { stdout += chunk; });
  processUnderTest.stderr.on("data", (chunk) => { stderr += chunk; });
  processUnderTest.stdin.end(input === undefined ? "" : JSON.stringify(input));
  const [code] = await once(processUnderTest, "exit");
  return { code, stdout, stderr };
}

test("opt-in pilot authenticates then reads only allowlisted destinations, printing no customer/provider payload", async () => {
  const app = await appFixture({ ...ready, outcomes: [{ ...outcome,
    account: { name: "private-account-name", externalId: "private-account-id" },
    campaigns: [{ externalId: "private-campaign-id" }] }] });
  try {
    const result = await runPilot(app.origin);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ready);
    assert.equal(result.stderr, "");
    assert.deepEqual(app.requests, [
      { path: "/api/auth/login", origin: app.origin, cookie: undefined, body: credentials },
      { path: "/api/ads/readiness", origin: app.origin, cookie: "launchpad_session=private-fixture-session",
        body: { destinationIds: ["dedicated-google"] } },
    ]);
    assert.doesNotMatch(result.stdout + result.stderr, /private-|never-echo-login/);
  } finally { await app.close(); }
});

test("pilot rejects missing opt-in, unapproved destinations and unsafe origins before sending credentials", async () => {
  const app = await appFixture(ready);
  try {
    for (const [origin, args, env] of [
      [app.origin, ["--mock", "--destination", "dedicated-google"], {}],
      [app.origin, ["--run-read-only", "--mock", "--destination", "arbitrary-customer"], {}],
      [app.origin, ["--run-read-only", "--destination", "dedicated-google"], {}],
      ["http://nonloopback.example.test", ["--run-read-only", "--mock", "--destination", "dedicated-google"], {}],
      [`${app.origin}/unexpected/path`, ["--run-read-only", "--mock", "--destination", "dedicated-google"], {}],
      [app.origin, ["--run-read-only", "--mock", "--destination", "dedicated-google", "--destination", "dedicated-google"], {}],
      [app.origin, ["--run-read-only", "--mock", "--destination", "dedicated-google"], { ADS_PILOT_ALLOWLIST: "[]" }],
      [app.origin, ["--run-read-only", "--mock", "--password", "secret-on-command-line"], {}],
    ] as [string, string[], Record<string, string>][]) {
      const result = await runPilot(origin, args, env);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /^Read-only pilot failed\./);
      assert.doesNotMatch(result.stderr, /private-|secret-on-command-line|arbitrary-customer/);
    }
    assert.deepEqual(app.requests, []);
  } finally { await app.close(); }
});

test("authentication failures are masked and never send a readiness request or retry", async () => {
  const app = await appFixture(ready, 401);
  try {
    const result = await runPilot(app.origin);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Read-only pilot failed\./);
    assert.doesNotMatch(result.stderr, /private-|never-echo-login/);
    assert.deepEqual(app.requests.map((request) => request.path), ["/api/auth/login"]);
  } finally { await app.close(); }
});

test("secret-store environment injection supports partial results without exposing provider errors", async () => {
  const denied = { destinationId: "dedicated-meta", provider: "META", success: false, canRead: false,
    canWrite: "DISABLED", error: { code: "RECONNECT_REQUIRED", message: "private-provider-secret" } };
  const app = await appFixture({ ...ready, success: false, partial: true, outcomes: [outcome, denied] });
  try {
    const result = await runPilot(app.origin,
      ["--run-read-only", "--mock", "--destination", "dedicated-google", "--destination", "dedicated-meta"],
      { ADS_PILOT_EMAIL: credentials.email, ADS_PILOT_PASSWORD: credentials.password,
        ADS_PILOT_ALLOWLIST: JSON.stringify(["dedicated-google", "dedicated-meta"]) }, {});
    assert.equal(result.code, 1);
    assert.deepEqual(JSON.parse(result.stdout), { ...ready, success: false, partial: true,
      outcomes: [outcome, { destinationId: "dedicated-meta", provider: "META", success: false,
        canRead: false, canWrite: "DISABLED" }] });
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stdout, /private-|RECONNECT_REQUIRED/);
    assert.equal(app.requests.length, 2);
    assert.deepEqual(app.requests[1].body, { destinationIds: ["dedicated-google", "dedicated-meta"] });
  } finally { await app.close(); }
});

test("mode confusion, enabled writes, substituted destinations and malformed readiness fail closed", async () => {
  for (const response of [
    { ...ready, mode: "live" },
    { ...ready, writesEnabled: true },
    { ...ready, outcomes: [{ ...outcome, destinationId: "another-customer" }] },
    { ...ready, outcomes: [{ ...outcome, canWrite: "ALLOWED" }] },
    { ...ready, outcomes: [{ ...outcome, provider: "private-provider-injection" }] },
    { ...ready, outcomes: [{ ...outcome, canRead: false }] },
    { ...ready, outcomes: [] },
    { ...ready, success: false },
    { mode: "mock", privateSecret: "private-malformed-response" },
  ]) {
    const app = await appFixture(response);
    try {
      const result = await runPilot(app.origin);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /^Read-only pilot failed\./);
      assert.doesNotMatch(result.stderr, /private-|another-customer/);
      assert.equal(app.requests.length, 2);
    } finally { await app.close(); }
  }
});

test("readiness redirects never forward the customer cookie or body to another origin", async () => {
  const other = await appFixture(ready);
  const app = await appFixture(ready, 200, `${other.origin}/api/ads/readiness`);
  try {
    const result = await runPilot(app.origin);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Read-only pilot failed\./);
    assert.doesNotMatch(result.stderr, /private-|127\.0\.0\.1/);
    assert.equal(app.requests.length, 2);
    assert.deepEqual(other.requests, []);
  } finally { await Promise.all([app.close(), other.close()]); }
});
