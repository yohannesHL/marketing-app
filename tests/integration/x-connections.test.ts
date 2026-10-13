import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient } from "@libsql/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../../apps/web/src/generated/prisma/client";
import {
  CustomerAuth,
  digest,
} from "../../apps/web/src/server/auth/customerAuth";
import { CredentialVault } from "../../apps/web/src/server/security/credentialVault";
import { CustomerConnections } from "../../apps/web/src/server/connections/customerConnections";
import { ProviderConnectionState } from "../../apps/web/src/server/connections/providerConnectionState";
import { SocialConnectionState } from "../../apps/web/src/server/connections/socialConnectionState";
import {
  SocialApiBudget,
  type ApiBudgetOwnerPolicy,
} from "../../apps/web/src/server/social/apiBudget";
import {
  XConnectionService,
  createXConnectionApi,
  type XConnectionRenewal,
} from "../../apps/web/src/server/connections/xConnectionApi";
import { XClient, X_SCOPES } from "../../apps/web/src/server/providers/x";
import { applyConnectionMigrations } from "../support/test-database";
import { startMockoon } from "../support/mockoon";
let directory: string,
  db: PrismaClient,
  auth: CustomerAuth,
  connections: CustomerConnections,
  state: ProviderConnectionState,
  social: SocialConnectionState;
let mock: Awaited<ReturnType<typeof startMockoon>>;
const origin = "https://launchpad.test";
let clock = new Date("2026-10-13T12:00:00Z");
const now = () => new Date(clock);
before(async () => {
  mock = await startMockoon("tests/mockoon/x.json");
  directory = await mkdtemp(join(tmpdir(), "x-connections-"));
  const url = `file:${join(directory, "test.db")}`;
  const sql = createClient({ url });
  await applyConnectionMigrations(sql);
  sql.close();
  db = new PrismaClient({ adapter: new PrismaLibSql({ url }) });
  const vault = new CredentialVault(
    { fixture: Buffer.alloc(32, 53).toString("base64") },
    "fixture",
  );
  auth = new CustomerAuth(db, { origin }, now);
  connections = new CustomerConnections(db, auth, vault, now);
  state = new ProviderConnectionState(db, auth, vault, now);
  social = new SocialConnectionState(db, auth, now);
});
after(async () => {
  await mock?.stop();
  await db?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});
const config = () => ({
  clientId: "x-client",
  clientSecret: "fixture-x-secret",
  redirectUri: `${origin}/api/connections/x/callback`,
  mockoonEnabled: true,
  mockoonBaseUrl: mock.origin,
  now,
});
async function customer(name: string, daily = 1000000) {
  await auth.provisionCustomer({
    email: `${name}@example.test`,
    name,
    password: "independent X connection fixture password",
  });
  const login = await auth.login(
      `${name}@example.test`,
      "independent X connection fixture password",
    ),
    cookie = login.cookie.split(";")[0],
    principal = await auth.requireSession(
      new Request(origin, { headers: { cookie } }),
    );
  const policy: ApiBudgetOwnerPolicy = {
    ownerId: principal.userId,
    mode: "mock",
    dailyLimitMicros: daily,
    deliveryLimitMicros: 1000000,
    operationCeilings: { USER_READ: 10000, POST_CREATE: 15000 },
  };
  const budget = new SocialApiBudget(db, [policy], now),
    build = (override = budget, renew?: XConnectionRenewal) =>
      new XConnectionService(
        db,
        auth,
        connections,
        state,
        social,
        override,
        config(),
        "mock",
        now,
        renew,
      ),
    service = build(),
    api = createXConnectionApi(auth, service);
  const request = (path: string, body: unknown = {}, method = "POST") =>
    new Request(origin + path, {
      method,
      headers: { cookie, Origin: origin, "Content-Type": "application/json" },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    });
  return { principal, cookie, policy, budget, service, api, build, request };
}
type Customer = Awaited<ReturnType<typeof customer>>;
async function connected(name: string) {
  const owner = await customer(name),
    start = await owner.service.start(owner.principal, 10000),
    stateValue = new URL(start.authorizationUrl).searchParams.get("state")!,
    result = await owner.service.complete(
      owner.principal,
      stateValue,
      "success",
    );
  return { owner, start, stateValue, result };
}
test("X OAuth requires authenticated explicit cost approval, safe origin and S256 least user scopes", async () => {
  const owner = await customer("x-auth");
  assert.equal(
    (
      await owner.api(
        new Request(origin + "/api/connections/x/start", { method: "POST" }),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await owner.api(
        new Request(origin + "/api/connections/x/start", {
          method: "POST",
          headers: { cookie: owner.cookie, Origin: "https://foreign.test" },
        }),
      )
    ).status,
    403,
  );
  assert.equal(
    (await owner.api(owner.request("/api/connections/x/start", {}))).status,
    400,
  );
  assert.equal(
    (
      await owner.api(
        owner.request("/api/connections/x/start", { maxApiCostMicros: 9999 }),
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await owner.api(
        owner.request("/api/connections/x/start", {
          maxApiCostMicros: 10000,
          accessToken: "forged",
        }),
      )
    ).status,
    400,
  );
  const response = await owner.api(
    owner.request("/api/connections/x/start", { maxApiCostMicros: 10000 }),
  );
  assert.equal(response.status, 200);
  const body = await response.json(),
    url = new URL(body.authorizationUrl),
    stateValue = url.searchParams.get("state")!;
  assert.equal(url.origin, mock.origin);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("scope"), X_SCOPES.join(" "));
  assert.equal(body.estimatedUserReadCostMicros, 10000);
  const row = await db.xConnectionCostApproval.findUniqueOrThrow({
    where: { stateHash: digest(stateValue) },
  });
  assert.equal(row.ownerId, owner.principal.userId);
  assert.equal(row.sessionId, owner.principal.sessionId);
  assert.equal(row.kind, "OAUTH");
  assert.equal(row.capMicros, 10000n);
  assert.ok(row.oauthAttemptId);
  assert.equal(
    await db.socialApiCostReservation.count({
      where: { connectionApprovalId: row.id },
    }),
    0,
  );
});
test("callback reserves real identity-read against actual OAuth approval and exposes verified SOCIAL destination only", async () => {
  const q = await connected("x-connect");
  assert.equal(q.result.connection.providerUserId, "1001");
  assert.equal(q.result.connection.capability, "SOCIAL");
  assert.deepEqual(q.result.connection.scopes, [...X_SCOPES].sort());
  assert.equal(q.result.connection.destinations[0].externalId, "1001");
  assert.equal(q.result.connection.destinations[0].selected, false);
  assert.equal(
    q.result.connection.destinations[0].name,
    "Fixture X user (@fixture_x)",
  );
  assert.doesNotMatch(
    JSON.stringify(q.result),
    /x-access|x-refresh|Ciphertext|fixture-x-secret|capMicros|console|balance/,
  );
  const approval = await db.xConnectionCostApproval.findUniqueOrThrow({
      where: { stateHash: digest(q.stateValue) },
    }),
    rows = await db.socialApiCostReservation.findMany({
      where: { connectionApprovalId: approval.id },
    });
  assert.ok(approval.consumedAt);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "CONNECTION");
  assert.equal(rows[0].operation, "USER_READ");
  assert.equal(rows[0].deliveryId, null);
  assert.equal(rows[0].revisionId, null);
  assert.equal(rows[0].costMicros, 10000n);
});
test("cross-customer/session/replay callbacks cannot borrow approval and denied consent spends nothing", async () => {
  const a = await customer("x-state-a"),
    b = await customer("x-state-b"),
    start = await a.service.start(a.principal, 10000),
    stateValue = new URL(start.authorizationUrl).searchParams.get("state")!;
  await assert.rejects(b.service.complete(b.principal, stateValue, "success"), {
    code: "INVALID_OAUTH_STATE",
  });
  const login = await auth.login(
      "x-state-a@example.test",
      "independent X connection fixture password",
    ),
    other = await auth.requireSession(
      new Request(origin, { headers: { cookie: login.cookie.split(";")[0] } }),
    );
  await assert.rejects(a.service.complete(other, stateValue, "success"), {
    code: "INVALID_OAUTH_STATE",
  });
  await assert.rejects(
    a.service.complete(a.principal, stateValue, undefined, true),
    { code: "CONSENT_DENIED" },
  );
  await assert.rejects(a.service.complete(a.principal, stateValue, "success"), {
    code: "INVALID_OAUTH_STATE",
  });
  const approval = await db.xConnectionCostApproval.findUniqueOrThrow({
    where: { stateHash: digest(stateValue) },
  });
  assert.equal(
    await db.socialApiCostReservation.count({
      where: { connectionApprovalId: approval.id },
    }),
    0,
  );
  const q = await connected("x-replay");
  await assert.rejects(
    q.owner.service.complete(q.owner.principal, q.stateValue, "success"),
    { code: "INVALID_OAUTH_STATE" },
  );
});
test("parallel callbacks claim once and missing scopes or forged reconnect subject never persist credentials", async () => {
  const a = await customer("x-parallel"),
    start = await a.service.start(a.principal, 10000),
    value = new URL(start.authorizationUrl).searchParams.get("state")!;
  const responses = await Promise.allSettled([
    a.service.complete(a.principal, value, "success"),
    a.service.complete(a.principal, value, "success"),
  ]);
  assert.equal(responses.filter((r) => r.status === "fulfilled").length, 1);
  const bad = await customer("x-scope"),
    s = await bad.service.start(bad.principal, 10000),
    v = new URL(s.authorizationUrl).searchParams.get("state")!;
  await assert.rejects(
    bad.service.complete(bad.principal, v, "missing-scope"),
    { code: "MISSING_PERMISSION" },
  );
  assert.equal(
    await db.providerAuthorization.count({
      where: { userId: bad.principal.userId },
    }),
    0,
  );
  const q = await connected("x-subject"),
    reconnect = await q.owner.service.start(
      q.owner.principal,
      10000,
      q.result.connection.id,
    ),
    r = new URL(reconnect.authorizationUrl).searchParams.get("state")!;
  await assert.rejects(
    q.owner.service.complete(q.owner.principal, r, "wrong-user"),
    { code: "PROVIDER_IDENTITY_MISMATCH" },
  );
  assert.equal(
    (await connections.get(q.owner.principal, q.result.connection.id))
      .credentialVersion,
    q.result.connection.credentialVersion,
  );
});
test("missing/expired approval and owner daily cap stop billable callback before a connection is stored", async () => {
  for (const reason of ["missing", "expired", "daily"]) {
    const owner = await customer(
        "x-budget-" + reason,
        reason === "daily" ? 10000 : 1000000,
      ),
      s = await owner.service.start(owner.principal, 10000),
      value = new URL(s.authorizationUrl).searchParams.get("state")!,
      approval = await db.xConnectionCostApproval.findUniqueOrThrow({
        where: { stateHash: digest(value) },
      });
    if (reason === "missing")
      await db.xConnectionCostApproval.delete({ where: { id: approval.id } });
    if (reason === "expired")
      await db.xConnectionCostApproval.update({
        where: { id: approval.id },
        data: { expiresAt: new Date(now().getTime() - 1) },
      });
    if (reason === "daily") {
      const first = await owner.service.start(owner.principal, 10000),
        v = new URL(first.authorizationUrl).searchParams.get("state")!;
      await owner.service.complete(owner.principal, v, "success");
    }
    await assert.rejects(
      owner.service.complete(owner.principal, value, "success"),
      {
        code:
          reason === "daily" ? "API_COST_LIMIT" : "API_COST_APPROVAL_REQUIRED",
      },
    );
    assert.equal(
      await db.providerAuthorization.count({
        where: { userId: owner.principal.userId },
      }),
      reason === "daily" ? 1 : 0,
    );
  }
});
test("cached selection performs no billed read; fresh check/refresh requires explicit approval and joins daily allocation", async () => {
  const a = await connected("x-selected"),
    b = await connected("x-foreign"),
    destination = a.result.connection.destinations[0],
    id = a.result.connection.id;
  const before = await db.socialApiCostReservation.count({
    where: { ownerId: a.owner.principal.userId },
  });
  const selected = await a.owner.service.select(
    a.owner.principal,
    id,
    destination.id,
  );
  assert.equal(selected.connection.destinations[0].selected, true);
  assert.equal(selected.verification, "CACHED_IDENTITY");
  assert.equal(
    await db.socialApiCostReservation.count({
      where: { ownerId: a.owner.principal.userId },
    }),
    before,
  );
  await assert.rejects(
    a.owner.service.select(
      a.owner.principal,
      id,
      b.result.connection.destinations[0].id,
    ),
    { code: "INVALID_SELECTION" },
  );
  assert.equal(
    (await a.owner.api(a.owner.request(`/api/connections/x/${id}/refresh`, {})))
      .status,
    400,
  );
  const checked = await a.owner.api(
    a.owner.request(`/api/connections/x/${id}/check`, {
      destinationId: destination.id,
      maxApiCostMicros: 10000,
    }),
  );
  assert.equal(checked.status, 200);
  assert.equal(
    await db.socialApiCostReservation.count({
      where: { ownerId: a.owner.principal.userId },
    }),
    before + 1,
  );
  const read = await db.xConnectionCostApproval.findFirstOrThrow({
    where: { ownerId: a.owner.principal.userId, kind: "CONNECTION_READ" },
  });
  assert.equal(read.authorizationId, id);
  assert.equal(read.oauthAttemptId, null);
  assert.equal(read.stateHash, null);
  assert.ok(read.consumedAt);
});
test("Ads grants, mode mismatch and expired credentials never become a selected Social profile or rotate directly", async () => {
  const q = await connected("x-local-guards"),
    id = q.result.connection.id,
    destination = q.result.connection.destinations[0].id;
  await db.providerAuthorization.update({
    where: { id },
    data: { connectionMode: "LIVE" },
  });
  await assert.rejects(
    q.owner.service.select(q.owner.principal, id, destination),
    { code: "CONNECTION_MODE_MISMATCH" },
  );
  await db.providerAuthorization.update({
    where: { id },
    data: { connectionMode: "MOCK", expiresAt: new Date(now().getTime() - 1) },
  });
  const version = (await connections.get(q.owner.principal, id))
    .credentialVersion;
  await assert.rejects(
    q.owner.service.select(q.owner.principal, id, destination),
    { code: "RECONNECT_REQUIRED" },
  );
  await assert.rejects(q.owner.service.refresh(q.owner.principal, id, 20000), {
    code: "RECONNECT_REQUIRED",
  });
  assert.equal(
    (await connections.get(q.owner.principal, id)).credentialVersion,
    version,
  );
  const oauth = {
    provider: "X" as const,
    capability: "ADS" as const,
    pkce: true,
    scopes: [...X_SCOPES],
    redirectUri: origin + "/api/connections/x/callback",
  };
  const attempt = await connections.beginOAuth(q.owner.principal, oauth),
    ads = await connections.completeAuthorization(
      q.owner.principal,
      attempt.state,
      oauth,
      {
        providerUserId: "1001",
        accessToken: "ads-only",
        scopes: [...X_SCOPES],
        connectionMode: "MOCK",
      },
    );
  await assert.rejects(
    q.owner.service.refresh(q.owner.principal, ads.id, 10000),
    { code: "NOT_FOUND" },
  );
});
test("expired read uses only injected serialized renewal seam and budgets both verified identity reads", async () => {
  const q = await connected("x-renew"),
    id = q.result.connection.id;
  await db.providerAuthorization.update({
    where: { id },
    data: { expiresAt: new Date(now().getTime() - 1) },
  });
  let calls = 0;
  // This exercises seam plumbing and real OAuth HTTP, not production renewal serialization.
  const renewal: XConnectionRenewal = async (req) => {
    calls++;
    assert.equal(req.authorizationId, id);
    assert.equal(req.mode, "mock");
    const current = await state.grant(q.owner.principal, id, "X", "SOCIAL");
    const renewed = await new XClient({
      ...config(),
      beforeRequest: req.verifyCurrent,
      beforeBillableRequest: req.beforeBillableRequest,
    }).renewVerified({
      providerUserId: req.providerUserId,
      refreshToken: current.refreshToken!,
    });
    await connections.updateCredentials(id, req.credentialVersion, renewed);
  };
  const service = q.owner.build(q.owner.budget, renewal);
  await assert.rejects(service.refresh(q.owner.principal, id, 10000), {
    code: "API_COST_LIMIT",
  });
  assert.equal(calls, 0);
  const result = await service.refresh(q.owner.principal, id, 20000);
  assert.equal(calls, 1);
  assert.equal(
    result.connection.credentialVersion,
    q.result.connection.credentialVersion + 1,
  );
  const approval = await db.xConnectionCostApproval.findFirstOrThrow({
    where: { ownerId: q.owner.principal.userId, kind: "CONNECTION_READ" },
  });
  assert.equal(
    await db.socialApiCostReservation.count({
      where: { connectionApprovalId: approval.id },
    }),
    2,
  );
});
test("logout after reservation stops the subsequent provider read/persistence and never refunds its conservative allocation", async () => {
  const q = await customer("x-logout");
  class LogoutBudget extends SocialApiBudget {
    override async reserveConnection(
      ...args: Parameters<SocialApiBudget["reserveConnection"]>
    ) {
      const result = await super.reserveConnection(...args);
      await auth.logout(q.principal);
      return result;
    }
  }
  const service = q.build(new LogoutBudget(db, [q.policy], now)),
    start = await service.start(q.principal, 10000),
    v = new URL(start.authorizationUrl).searchParams.get("state")!;
  await assert.rejects(service.complete(q.principal, v, "success"), {
    code: "API_COST_APPROVAL_REQUIRED",
  });
  assert.equal(
    await db.providerAuthorization.count({
      where: { userId: q.principal.userId },
    }),
    0,
  );
  assert.equal(
    await db.socialApiCostReservation.count({
      where: { ownerId: q.principal.userId },
    }),
    1,
  );
});
test("browser redirect omits raw state/provider payload and runtime owner policies fail closed", async () => {
  const q = await customer("x-browser"),
    start = await q.service.start(q.principal, 10000),
    v = new URL(start.authorizationUrl).searchParams.get("state")!;
  const response = await q.api(
    new Request(
      `${origin}/api/connections/x/callback?state=${v}&error=access_denied&error_description=secret-provider-payload`,
      { headers: { cookie: q.cookie, Accept: "text/html" } },
    ),
  );
  assert.equal(response.status, 303);
  assert.equal(
    response.headers.get("location"),
    origin + "/connections?provider=x&result=failed&error=CONSENT_DENIED",
  );
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  const unavailable = q.build(new SocialApiBudget(db, [], now));
  await assert.rejects(unavailable.start(q.principal, 10000), {
    code: "API_COST_APPROVAL_REQUIRED",
  });
  assert.throws(
    () =>
      new XConnectionService(
        db,
        auth,
        connections,
        state,
        social,
        q.budget,
        config(),
        "live",
        now,
      ),
    { code: "CONNECTION_MODE_MISMATCH" },
  );
});
