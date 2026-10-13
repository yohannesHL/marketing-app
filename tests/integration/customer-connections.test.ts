import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../../apps/web/src/generated/prisma/client";
import { CustomerAuth } from "../../apps/web/src/server/auth/customerAuth";
import { CredentialVault } from "../../apps/web/src/server/security/credentialVault";
import { CustomerConnections } from "../../apps/web/src/server/connections/customerConnections";
import { createCustomerApi } from "../../apps/web/src/server/security/customerApi";
import {
  migrateLegacyCredentials,
  rotateCredentialKeys,
  legacyContext,
} from "../../apps/web/src/server/connections/credentialMaintenance";
import { credentialContext } from "../../apps/web/src/server/connections/customerConnections";
import { redact } from "../../apps/web/src/server/security/redact";

let directory: string;
let db: PrismaClient;
let auth: CustomerAuth;
let connections: CustomerConnections;
let clock = new Date("2026-10-13T09:00:00Z");

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "launchpad-security-"));
  const url = `file:${join(directory, "test.db")}`;
  const client = createClient({ url });
  await client.executeMultiple(
    await readFile("tests/fixtures/legacy-account-schema.sql", "utf8"),
  );
  await client.executeMultiple(
    await readFile(
      "apps/web/prisma/migrations/20261013000000_customer_connections/migration.sql",
      "utf8",
    ),
  );
  client.close();
  db = new PrismaClient({ adapter: new PrismaLibSql({ url }) });
  auth = new CustomerAuth(
    db,
    { origin: "https://launchpad.test" },
    () => clock,
  );
  connections = new CustomerConnections(
    db,
    auth,
    new CredentialVault(
      { first: Buffer.alloc(32, 7).toString("base64") },
      "first",
    ),
    () => clock,
  );
});

async function signedIn(email: string) {
  const customer = await auth.provisionCustomer({
    email,
    name: email,
    password: "another independent long password",
  });
  const login = await auth.login(email, "another independent long password");
  const request = new Request("https://launchpad.test/api/connections", {
    headers: { cookie: login.cookie.split(";")[0] },
  });
  return { customer, principal: await auth.requireSession(request), request };
}

const oauth = {
  provider: "GOOGLE" as const,
  capability: "ADS" as const,
  redirectUri: "https://launchpad.test/api/connections/google/callback",
  scopes: ["ads.manage"],
  pkce: true,
};
const grant = {
  providerUserId: "google-user-1",
  accessToken: "sensitive-google-access",
  refreshToken: "sensitive-google-refresh",
  scopes: ["ads.manage"],
  expiresAt: new Date("2026-10-13T10:00:00Z"),
};

test("OAuth attempts are bound to session, provider, capability and callback, expire and can be consumed once", async () => {
  const alice = await signedIn("oauth-alice@example.test");
  const bob = await signedIn("oauth-bob@example.test");
  const attempt = await connections.beginOAuth(alice.principal, oauth);
  assert.equal(attempt.codeChallengeMethod, "S256");
  assert.ok(attempt.codeChallenge);
  await assert.rejects(
    connections.completeAuthorization(
      bob.principal,
      attempt.state,
      oauth,
      grant,
    ),
    { code: "INVALID_OAUTH_STATE" },
  );
  await assert.rejects(
    connections.completeAuthorization(
      alice.principal,
      attempt.state + "x",
      oauth,
      grant,
    ),
    { code: "INVALID_OAUTH_STATE" },
  );
  await assert.rejects(
    connections.completeAuthorization(
      alice.principal,
      attempt.state,
      { ...oauth, capability: "SOCIAL" },
      grant,
    ),
    { code: "INVALID_OAUTH_STATE" },
  );
  await assert.rejects(
    connections.completeAuthorization(
      alice.principal,
      attempt.state,
      { ...oauth, provider: "META" },
      grant,
    ),
    { code: "INVALID_OAUTH_STATE" },
  );
  await assert.rejects(
    connections.completeAuthorization(
      alice.principal,
      attempt.state,
      { ...oauth, redirectUri: oauth.redirectUri + "?other=1" },
      grant,
    ),
    { code: "INVALID_OAUTH_STATE" },
  );
  const complete = await connections.completeAuthorization(
    alice.principal,
    attempt.state,
    oauth,
    grant,
  );
  assert.equal(complete.capability, "ADS");
  assert.equal(JSON.stringify(complete).includes(grant.accessToken), false);
  await assert.rejects(
    connections.completeAuthorization(
      alice.principal,
      attempt.state,
      oauth,
      grant,
    ),
    { code: "INVALID_OAUTH_STATE" },
  );
  const expired = await connections.beginOAuth(alice.principal, oauth);
  clock = new Date(clock.getTime() + 11 * 60 * 1000);
  await assert.rejects(
    connections.completeAuthorization(
      alice.principal,
      expired.state,
      oauth,
      grant,
    ),
    { code: "INVALID_OAUTH_STATE" },
  );
  clock = new Date("2026-10-13T09:00:00Z");
});

async function connected(
  principal: Awaited<ReturnType<typeof signedIn>>["principal"],
  capability: "ADS" | "SOCIAL" = "ADS",
) {
  const input = {
    ...oauth,
    capability,
    scopes: capability === "ADS" ? ["ads.manage"] : ["social.publish"],
  };
  const attempt = await connections.beginOAuth(principal, input);
  return connections.completeAuthorization(principal, attempt.state, input, {
    ...grant,
    scopes: input.scopes,
  });
}

function synchronizeFirstTwoReads(
  delegate: "oAuthAttempt" | "connectionOperation",
  method: "findFirst" | "findUnique",
) {
  let completed = 0;
  let release!: () => void;
  const bothRead = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model = new Proxy(db[delegate], {
    get(target, property) {
      if (property === method)
        return async (...args: unknown[]) => {
          const snapshot = await Reflect.apply(
            Reflect.get(target, property),
            target,
            args,
          );
          if (++completed === 2) release();
          if (completed <= 2) await bothRead;
          return snapshot;
        };
      return Reflect.get(target, property);
    },
  });
  // Both callers observe the same real persisted state before either proceeds
  // to the transaction/claim; no timing delays or fabricated rows are involved.
  return new Proxy(db, {
    get(target, property) {
      return property === delegate ? model : Reflect.get(target, property);
    },
  });
}

test("concurrent callbacks can complete the same OAuth state only once", { timeout: 10_000 }, async () => {
  const alice = await signedIn("oauth-claim@example.test");
  const attempt = await connections.beginOAuth(alice.principal, oauth);
  const concurrent = new CustomerConnections(
    synchronizeFirstTwoReads("oAuthAttempt", "findFirst"),
    auth,
    new CredentialVault(
      { first: Buffer.alloc(32, 7).toString("base64") },
      "first",
    ),
    () => clock,
  );
  const results = await Promise.allSettled([
    concurrent.completeAuthorization(
      alice.principal, attempt.state, oauth, grant,
    ),
    concurrent.completeAuthorization(
      alice.principal, attempt.state, oauth, grant,
    ),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected?.reason.code, "INVALID_OAUTH_STATE");
  assert.equal((await connections.list(alice.principal)).length, 1);
});

test("concurrent workers invoke the same operation only once", { timeout: 10_000 }, async () => {
  const alice = await signedIn("operation-claim@example.test");
  const authorization = await connected(alice.principal);
  const destination = await connections.registerDestination(
    alice.principal,
    authorization.id,
    { externalId: "single-claim-account", kind: "AD_ACCOUNT" },
  );
  await connections.selectDestination(alice.principal, destination.id, true);
  const job = await connections.queueOperation(
    alice.principal,
    destination.id,
    "ADS",
    ["ads.manage"],
  );
  const concurrent = new CustomerConnections(
    synchronizeFirstTwoReads("connectionOperation", "findUnique"),
    auth,
    new CredentialVault(
      { first: Buffer.alloc(32, 7).toString("base64") },
      "first",
    ),
    () => clock,
  );
  let submissions = 0;
  const invoke = async () => {
    submissions++;
    return "provider-result";
  };
  const results = await Promise.allSettled([
    concurrent.runOperation(job.id, invoke),
    concurrent.runOperation(job.id, invoke),
  ]);
  assert.equal(submissions, 1);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected?.reason.code, "OPERATION_UNAVAILABLE");
});

test("connections isolate customers and capabilities, and disconnect prevents queued credential use", async () => {
  const alice = await signedIn("lifecycle-alice@example.test");
  const bob = await signedIn("lifecycle-bob@example.test");
  const ads = await connected(alice.principal);
  const social = await connected(alice.principal, "SOCIAL");
  const account = await connections.registerDestination(
    alice.principal,
    ads.id,
    {
      externalId: "customer-123",
      kind: "AD_ACCOUNT",
      name: "Alice Ads",
      currency: "GBP",
      timezone: "Europe/London",
    },
  );
  const channel = await connections.registerDestination(
    alice.principal,
    social.id,
    {
      externalId: "channel-123",
      kind: "YOUTUBE_CHANNEL",
      name: "Alice Channel",
    },
  );
  await connections.selectDestination(alice.principal, account.id, true);
  await connections.selectDestination(alice.principal, channel.id, true);
  assert.deepEqual(await connections.list(bob.principal), []);
  await assert.rejects(connections.get(bob.principal, ads.id), {
    code: "NOT_FOUND",
  });
  await assert.rejects(
    connections.selectDestination(bob.principal, account.id, true),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(connections.disconnect(bob.principal, ads.id), {
    code: "NOT_FOUND",
  });
  await assert.rejects(
    connections.queueOperation(alice.principal, account.id, "SOCIAL", [
      "social.publish",
    ]),
    { code: "WRONG_CAPABILITY" },
  );
  await assert.rejects(
    connections.queueOperation(alice.principal, account.id, "ADS", [
      "missing.scope",
    ]),
    { code: "MISSING_PERMISSION" },
  );
  const pending = await connections.queueOperation(
    alice.principal,
    account.id,
    "ADS",
    ["ads.manage"],
  );
  await connections.disconnect(alice.principal, ads.id);
  let calls = 0;
  await assert.rejects(
    connections.runOperation(pending.id, async () => {
      calls++;
    }),
    { code: "OPERATION_UNAVAILABLE" },
  );
  assert.equal(calls, 0);
  assert.equal(
    (await connections.get(alice.principal, ads.id)).status,
    "DISCONNECTED",
  );
  const socialJob = await connections.queueOperation(
    alice.principal,
    channel.id,
    "SOCIAL",
    ["social.publish"],
  );
  await connections.runOperation(socialJob.id, async (credentials) => {
    assert.equal(credentials.externalId, "channel-123");
    assert.equal(credentials.accessToken, grant.accessToken);
    calls++;
  });
  assert.equal(calls, 1);
  const reconnected = await connected(alice.principal);
  assert.equal(reconnected.id, ads.id);
  assert.equal(reconnected.destinations.length, 1);
  assert.equal(reconnected.destinations[0].selected, false);
  assert.equal((await connections.list(alice.principal)).length, 2);
  assert.equal(
    JSON.stringify(await connections.list(alice.principal)).includes(
      "sensitive-",
    ),
    false,
  );
});

test("disconnect and revocation invalidate earlier OAuth attempts across customer sessions", async () => {
  const alice = await signedIn("oauth-disable-alice@example.test");
  const bob = await signedIn("oauth-disable-bob@example.test");
  const authorization = await connected(alice.principal);
  const secondLogin = await auth.login(
    "oauth-disable-alice@example.test",
    "another independent long password",
  );
  const secondSession = await auth.requireSession(
    new Request(alice.request.url, {
      headers: { cookie: secondLogin.cookie.split(";")[0] },
    }),
  );
  const pending = await connections.beginOAuth(secondSession, oauth);
  const socialInput = { ...oauth, capability: "SOCIAL" as const };
  const socialPending = await connections.beginOAuth(
    alice.principal,
    socialInput,
  );
  const bobPending = await connections.beginOAuth(bob.principal, oauth);
  // The provider exchange may already be underway when the customer disconnects.
  await connections.getOAuthExchangeContext(secondSession, pending.state, oauth);
  await connections.disconnect(alice.principal, authorization.id);
  await assert.rejects(
    connections.getOAuthExchangeContext(secondSession, pending.state, oauth),
    { code: "INVALID_OAUTH_STATE" },
  );
  await assert.rejects(
    connections.completeAuthorization(
      secondSession,
      pending.state,
      oauth,
      grant,
    ),
    { code: "INVALID_OAUTH_STATE" },
  );
  // Disconnecting Ads preserves Social attempts and other customers' attempts.
  await connections.completeAuthorization(
    alice.principal,
    socialPending.state,
    socialInput,
    grant,
  );
  await connections.completeAuthorization(
    bob.principal,
    bobPending.state,
    oauth,
    grant,
  );
  const fresh = await connections.beginOAuth(alice.principal, oauth);
  await connections.completeAuthorization(alice.principal, fresh.state, oauth, {
    ...grant,
    externalGrantId: "revoked-oauth-grant",
  });
  const revokedPending = await connections.beginOAuth(alice.principal, oauth);
  await connections.markProviderRevoked("GOOGLE", "revoked-oauth-grant");
  await assert.rejects(
    connections.completeAuthorization(
      alice.principal,
      revokedPending.state,
      oauth,
      grant,
    ),
    { code: "INVALID_OAUTH_STATE" },
  );
});

test("HTTP session and connection APIs reject unauthenticated, cross-origin and cross-customer access", async () => {
  const alice = await signedIn("http-alice@example.test");
  const bob = await signedIn("http-bob@example.test");
  const api = createCustomerApi(auth, connections);
  const authorization = await connected(alice.principal);
  assert.equal(
    (await api(new Request("https://launchpad.test/api/connections"))).status,
    401,
  );
  assert.equal(
    (
      await api(
        new Request(
          `https://launchpad.test/api/connections/${authorization.id}`,
          { headers: bob.request.headers },
        ),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await api(
        new Request(
          `https://launchpad.test/api/connections/${authorization.id}`,
          {
            method: "DELETE",
            headers: {
              ...Object.fromEntries(alice.request.headers),
              origin: "https://attacker.test",
            },
          },
        ),
      )
    ).status,
    403,
  );
  const list = await api(alice.request);
  assert.equal(list.headers.get("cache-control"), "no-store");
  assert.equal((await list.text()).includes("sensitive-"), false);
  const malformed = await api(
    new Request("https://launchpad.test/api/auth/login", {
      method: "POST",
      headers: {
        origin: "https://launchpad.test",
        "content-type": "application/json",
      },
      body: "{",
    }),
  );
  assert.equal(malformed.status, 400);
  const fakeOrigin = await api(
    new Request("https://launchpad.test/api/auth/login", {
      method: "POST",
      headers: {
        origin: "https://attacker.test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        email: "http-alice@example.test",
        password: "another independent long password",
      }),
    }),
  );
  assert.equal(fakeOrigin.status, 403);
  const signedOut = await api(
    new Request("https://launchpad.test/api/auth/session", {
      method: "DELETE",
      headers: {
        ...Object.fromEntries(alice.request.headers),
        origin: "https://launchpad.test",
      },
    }),
  );
  assert.equal(signedOut.status, 200);
  assert.equal((await api(alice.request)).status, 401);
});

test("expiry and provider revocation stop future work and a stale refresh cannot undo disconnect", async () => {
  const alice = await signedIn("expiry-alice@example.test");
  const authorization = await connected(alice.principal);
  const destination = await connections.registerDestination(
    alice.principal,
    authorization.id,
    { externalId: "expiry-account", kind: "AD_ACCOUNT" },
  );
  await connections.selectDestination(alice.principal, destination.id, true);
  const job = await connections.queueOperation(
    alice.principal,
    destination.id,
    "ADS",
    ["ads.manage"],
  );
  clock = new Date("2026-10-13T11:00:00Z");
  await assert.rejects(
    connections.runOperation(job.id, async () =>
      assert.fail("expired credentials were used"),
    ),
    { code: "RECONNECT_REQUIRED" },
  );
  clock = new Date("2026-10-13T09:00:00Z");
  await connections.disconnect(alice.principal, authorization.id);
  await assert.rejects(
    connections.updateCredentials(authorization.id, 1, {
      ...grant,
      accessToken: "late-refreshed-token",
    }),
    { code: "RECONNECT_REQUIRED" },
  );
  const input = { ...oauth };
  const attempt = await connections.beginOAuth(alice.principal, input);
  await connections.completeAuthorization(
    alice.principal,
    attempt.state,
    input,
    { ...grant, externalGrantId: "shared-provider-grant" },
  );
  const socialInput = { ...oauth, capability: "SOCIAL" as const };
  const socialAttempt = await connections.beginOAuth(
    alice.principal,
    socialInput,
  );
  const social = await connections.completeAuthorization(
    alice.principal,
    socialAttempt.state,
    socialInput,
    { ...grant, externalGrantId: "shared-provider-grant" },
  );
  await connections.markProviderRevoked("GOOGLE", "shared-provider-grant");
  assert.equal(
    (await connections.get(alice.principal, authorization.id)).status,
    "REVOKED",
  );
  assert.equal(
    (await connections.get(alice.principal, social.id)).status,
    "REVOKED",
  );
});

test("concurrent destinations retain their own credentials and reconnect cancels old work", async () => {
  const alice = await signedIn("concurrent-alice@example.test");
  const input = { ...oauth };
  const oneAttempt = await connections.beginOAuth(alice.principal, input);
  const one = await connections.completeAuthorization(
    alice.principal,
    oneAttempt.state,
    input,
    {
      ...grant,
      providerUserId: "first-provider-user",
      accessToken: "first-account-token",
    },
  );
  const twoAttempt = await connections.beginOAuth(alice.principal, input);
  const two = await connections.completeAuthorization(
    alice.principal,
    twoAttempt.state,
    input,
    {
      ...grant,
      providerUserId: "second-provider-user",
      accessToken: "second-account-token",
    },
  );
  const first = await connections.registerDestination(alice.principal, one.id, {
    externalId: "first-account",
    kind: "AD_ACCOUNT",
  });
  const second = await connections.registerDestination(
    alice.principal,
    two.id,
    { externalId: "second-account", kind: "AD_ACCOUNT" },
  );
  await connections.selectDestination(alice.principal, first.id, true);
  await connections.selectDestination(alice.principal, second.id, true);
  const firstJob = await connections.queueOperation(
    alice.principal,
    first.id,
    "ADS",
    ["ads.manage"],
  );
  const secondJob = await connections.queueOperation(
    alice.principal,
    second.id,
    "ADS",
    ["ads.manage"],
  );
  const seen = await Promise.all([
    connections.runOperation(firstJob.id, async (context) => ({
      account: context.externalId,
      token: context.accessToken,
    })),
    connections.runOperation(secondJob.id, async (context) => ({
      account: context.externalId,
      token: context.accessToken,
    })),
  ]);
  assert.deepEqual(seen, [
    { account: "first-account", token: "first-account-token" },
    { account: "second-account", token: "second-account-token" },
  ]);
  const oldJob = await connections.queueOperation(
    alice.principal,
    first.id,
    "ADS",
    ["ads.manage"],
  );
  const reconnect = await connections.beginOAuth(alice.principal, input);
  const same = await connections.completeAuthorization(
    alice.principal,
    reconnect.state,
    input,
    {
      ...grant,
      providerUserId: "first-provider-user",
      accessToken: "replacement-token",
      refreshToken: undefined,
    },
  );
  assert.equal(same.id, one.id);
  assert.equal(same.destinations[0].id, first.id);
  await assert.rejects(
    connections.runOperation(oldJob.id, async () =>
      assert.fail("reconnected job reused credentials"),
    ),
    { code: "OPERATION_UNAVAILABLE" },
  );
  await connections.renewAuthorization(
    alice.principal,
    one.id,
    async ({ refreshToken }) => {
      assert.equal(refreshToken, grant.refreshToken);
      return {
        accessToken: "renewed-token",
        scopes: ["ads.manage"],
        expiresAt: grant.expiresAt,
      };
    },
  );
  const renewedJob = await connections.queueOperation(
    alice.principal,
    first.id,
    "ADS",
    ["ads.manage"],
  );
  await connections.runOperation(renewedJob.id, async ({ accessToken }) =>
    assert.equal(accessToken, "renewed-token"),
  );
});

test("password reset rejects an old-password login already in progress", async () => {
  const email = "reset-race@example.test";
  const oldPassword = "the original sufficiently long password";
  const newPassword = "the replacement sufficiently long password";
  const customer = await auth.provisionCustomer({
    email,
    name: "Reset race",
    password: oldPassword,
  });
  let signalLookup!: () => void;
  let resumeLogin!: () => void;
  const lookup = new Promise<void>((resolve) => {
    signalLookup = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    resumeLogin = resolve;
  });
  // Delay the real database response after reading the password snapshot so the
  // reset deterministically completes while the sign-in request is in flight.
  const delayedDb = new Proxy(db, {
    get(target, property) {
      if (property === "user")
        return new Proxy(target.user, {
          get(model, method) {
            if (method === "findUnique")
              return async (args: Parameters<typeof model.findUnique>[0]) => {
                const snapshot = await model.findUnique(args);
                signalLookup();
                await resume;
                return snapshot;
              };
            return Reflect.get(model, method);
          },
        });
      return Reflect.get(target, property);
    },
  });
  const delayedAuth = new CustomerAuth(
    delayedDb,
    { origin: auth.origin },
    () => clock,
  );
  const rejected = assert.rejects(delayedAuth.login(email, oldPassword), {
    code: "INVALID_LOGIN",
  });
  await lookup;
  try {
    await auth.provisionCustomer({
      userId: customer.id,
      email,
      name: "Reset race",
      password: newPassword,
    });
  } finally {
    resumeLogin();
  }
  await rejected;
  const login = await auth.login(email, newPassword);
  const principal = await auth.requireSession(
    new Request("https://launchpad.test/api/auth/session", {
      headers: { cookie: login.cookie.split(";")[0] },
    }),
  );
  assert.equal(principal.userId, customer.id);
});

test("another session of the same customer cannot reuse OAuth state and password reset expires old sessions", async () => {
  const alice = await signedIn("session-alice@example.test");
  const attempt = await connections.beginOAuth(alice.principal, oauth);
  const secondLogin = await auth.login(
    "session-alice@example.test",
    "another independent long password",
  );
  const second = await auth.requireSession(
    new Request(alice.request.url, {
      headers: { cookie: secondLogin.cookie.split(";")[0] },
    }),
  );
  await assert.rejects(
    connections.completeAuthorization(second, attempt.state, oauth, grant),
    { code: "INVALID_OAUTH_STATE" },
  );
  await auth.provisionCustomer({
    userId: alice.customer.id,
    email: "session-alice@example.test",
    name: "Alice",
    password: "replacement operator provisioned password",
  });
  await assert.rejects(auth.requireSession(alice.request), {
    code: "UNAUTHENTICATED",
  });
  await assert.rejects(
    connections.completeAuthorization(
      alice.principal,
      attempt.state,
      oauth,
      grant,
    ),
    { code: "UNAUTHENTICATED" },
  );
  const renewed = await auth.login(
    "session-alice@example.test",
    "replacement operator provisioned password",
  );
  const request = new Request(alice.request.url, {
    headers: { cookie: renewed.cookie.split(";")[0] },
  });
  clock = new Date(clock.getTime() + 8 * 24 * 60 * 60 * 1000);
  await assert.rejects(auth.requireSession(request), {
    code: "UNAUTHENTICATED",
  });
  clock = new Date("2026-10-13T09:00:00Z");
});

test("redaction removes OAuth state, codes and tokens from absolute and relative request URLs", () => {
  const redacted = redact({
    state: "oauth-state-private",
    code: "authorization-code-private",
    codeVerifier: "pkce-private",
    callback:
      "https://launchpad.test/api/connections/google/callback?state=oauth-state-private&code=authorization-code-private&keep=yes",
    path: "/oauth?access_token=access-private&fields=id",
    rootless: "act_123?refresh_token=refresh-private&fields=name",
    note: "Campaign state approved.",
  }) as Record<string, string>;
  assert.equal(JSON.stringify(redacted).includes("-private"), false);
  assert.equal(redacted.state, "[REDACTED]");
  assert.equal(redacted.code, "[REDACTED]");
  assert.equal(redacted.codeVerifier, "[REDACTED]");
  const callback = new URL(redacted.callback);
  assert.equal(callback.searchParams.get("state"), "[REDACTED]");
  assert.equal(callback.searchParams.get("code"), "[REDACTED]");
  assert.equal(callback.searchParams.get("keep"), "yes");
  assert.equal(redacted.path, "/oauth?access_token=%5BREDACTED%5D&fields=id");
  assert.equal(
    redacted.rootless,
    "act_123?refresh_token=%5BREDACTED%5D&fields=name",
  );
  assert.equal(redacted.note, "Campaign state approved.");
});

test("redaction removes signed provider callbacks and OAuth URL fragment credentials", () => {
  const redacted = redact({
    signed_request: "signed-payload-private",
    signedRequest: "signed-camel-private",
    signature: "signature-private",
    callback:
      "https://launchpad.test/callback?signed_request=query-private#access_token=fragment-private&state=state-private&code=code-private&keep=yes",
    relative:
      "/callback#access_token=relative-private&state=state-private&code=code-private&keep=yes",
    rootless: "callback?signature=query-private#code=code-private",
    ordinary: "/campaigns?view=calendar#planned",
  }) as Record<string, string>;
  assert.equal(JSON.stringify(redacted).includes("-private"), false);
  assert.equal(redacted.signed_request, "[REDACTED]");
  assert.equal(redacted.signedRequest, "[REDACTED]");
  assert.equal(redacted.signature, "[REDACTED]");
  const callback = new URL(redacted.callback);
  assert.equal(callback.searchParams.get("signed_request"), "[REDACTED]");
  const fragment = new URLSearchParams(callback.hash.slice(1));
  assert.equal(fragment.get("access_token"), "[REDACTED]");
  assert.equal(fragment.get("state"), "[REDACTED]");
  assert.equal(fragment.get("code"), "[REDACTED]");
  assert.equal(fragment.get("keep"), "yes");
  assert.equal(
    redacted.relative,
    "/callback#access_token=%5BREDACTED%5D&state=%5BREDACTED%5D&code=%5BREDACTED%5D&keep=yes",
  );
  assert.equal(
    redacted.rootless,
    "callback?signature=%5BREDACTED%5D#code=%5BREDACTED%5D",
  );
  assert.equal(redacted.ordinary, "/campaigns?view=calendar#planned");
});

test("legacy credentials migrate without losing account data and key rotation preserves decryptability", async () => {
  const alice = await signedIn("legacy-alice@example.test");
  await db.platformUserAccount.create({
    data: {
      id: "legacy-owned",
      userId: alice.customer.id,
      platform: "META",
      externalId: "legacy-123",
      name: "Preserved account",
      accessToken: "legacy-owned-secret",
    },
  });
  await db.platformAccount.create({
    data: {
      id: "legacy-unowned",
      platform: "GOOGLE",
      externalId: "unknown-owner",
      accessToken: "legacy-unowned-secret",
    },
  });
  const oldVault = new CredentialVault(
    { first: Buffer.alloc(32, 7).toString("base64") },
    "first",
  );
  assert.equal((await migrateLegacyCredentials(db, oldVault)).encrypted, 2);
  assert.equal((await migrateLegacyCredentials(db, oldVault)).encrypted, 0);
  const databaseBytes = await readFile(join(directory, "test.db"));
  assert.equal(
    databaseBytes.includes(Buffer.from("legacy-owned-secret")),
    false,
  );
  assert.equal(
    databaseBytes.includes(Buffer.from("legacy-unowned-secret")),
    false,
  );
  const legacy = (await connections.list(alice.principal))[0];
  assert.equal(legacy.status, "RECONNECT_REQUIRED");
  assert.equal(legacy.destinations[0].name, "Preserved account");
  assert.equal(legacy.destinations[0].selected, false);
  // Independent storage audit verifies the at-rest guarantee, not query structure.
  const stored = await db.providerAuthorization.findUniqueOrThrow({
    where: { id: legacy.id },
  });
  assert.equal(JSON.stringify(stored).includes("legacy-owned-secret"), false);
  const oldAccount = await db.platformUserAccount.findUniqueOrThrow({
    where: { id: "legacy-owned" },
  });
  assert.equal(
    oldVault.decrypt(
      oldAccount.accessToken,
      legacyContext("user", oldAccount.id, oldAccount.userId),
    ),
    "legacy-owned-secret",
  );
  await assert.rejects(
    async () =>
      oldVault.decrypt(
        stored.accessCiphertext!,
        credentialContext("other-customer", legacy.id, "access"),
      ),
    { code: "CREDENTIAL_UNAVAILABLE" },
  );
  const rotatingVault = new CredentialVault(
    {
      first: Buffer.alloc(32, 7).toString("base64"),
      second: Buffer.alloc(32, 9).toString("base64"),
    },
    "second",
  );
  await rotateCredentialKeys(db, rotatingVault);
  const newVault = new CredentialVault(
    { second: Buffer.alloc(32, 9).toString("base64") },
    "second",
  );
  const rotated = await db.providerAuthorization.findUniqueOrThrow({
    where: { id: legacy.id },
  });
  assert.equal(
    newVault.decrypt(
      rotated.accessCiphertext!,
      credentialContext(alice.customer.id, legacy.id, "access"),
    ),
    "legacy-owned-secret",
  );
  assert.equal(
    JSON.stringify(
      redact({
        Authorization: "Bearer private",
        nested: { accessToken: "private" },
        url: "https://api.test/?access_token=private",
      }),
    ).includes("private"),
    false,
  );
  // Restore the test key for later tests while exercising two-way rotation.
  await rotateCredentialKeys(
    db,
    new CredentialVault(
      {
        first: Buffer.alloc(32, 7).toString("base64"),
        second: Buffer.alloc(32, 9).toString("base64"),
      },
      "first",
    ),
  );
});

after(async () => {
  await db?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("signed-in customers get private server sessions and cannot forge their identity", async () => {
  const customer = await auth.provisionCustomer({
    email: "alice@example.test",
    name: "Alice",
    password: "a long independent password",
  });
  const login = await auth.login(
    "ALICE@example.test",
    "a long independent password",
  );
  assert.match(login.cookie, /HttpOnly/);
  assert.match(login.cookie, /Secure/);
  assert.match(login.cookie, /SameSite=Lax/);
  const request = new Request(
    "https://launchpad.test/api/connections?userId=somebody-else",
    {
      headers: { cookie: login.cookie.split(";")[0] },
    },
  );
  const principal = await auth.requireSession(request);
  assert.equal(principal.userId, customer.id);
  await assert.rejects(auth.requireSession(new Request(request.url)), {
    code: "UNAUTHENTICATED",
  });
  await auth.logout(principal);
  await assert.rejects(auth.requireSession(request), {
    code: "UNAUTHENTICATED",
  });
});
