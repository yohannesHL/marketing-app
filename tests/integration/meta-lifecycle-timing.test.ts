import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../../apps/web/src/generated/prisma/client";
import { CustomerAuth, digest } from "../../apps/web/src/server/auth/customerAuth";
import { CustomerConnections } from "../../apps/web/src/server/connections/customerConnections";
import { CredentialVault } from "../../apps/web/src/server/security/credentialVault";
import { MetaLifecycleStore } from "../../apps/web/src/server/connections/metaLifecycleStore";
import { applyConnectionMigrations } from "../support/test-database";

let directory: string;
let db: PrismaClient;
let auth: CustomerAuth;
let connections: CustomerConnections;
let lifecycle: MetaLifecycleStore;
const clock = new Date("2026-10-13T12:00:00.700Z");
const oauth = { provider: "META" as const, capability: "ADS" as const, pkce: false,
  scopes: ["ads_management"], redirectUri: "https://launchpad.test/api/connections/meta/callback" };
const grant = { providerUserId: "1001", externalGrantId: "1001", accessToken: "private-fixture-token",
  scopes: oauth.scopes, connectionMode: "MOCK" as const };

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "meta-callback-timing-"));
  const url = `file:${join(directory, "test.db")}`;
  const sqlite = createClient({ url }); await applyConnectionMigrations(sqlite); sqlite.close();
  db = new PrismaClient({ adapter: new PrismaLibSql({ url }) });
  auth = new CustomerAuth(db, { origin: "https://launchpad.test" }, () => clock);
  connections = new CustomerConnections(db, auth,
    new CredentialVault({ test: Buffer.alloc(32, 33).toString("base64") }, "test"), () => clock);
  lifecycle = new MetaLifecycleStore(db, { origin: "https://launchpad.test", mode: "mock" }, () => clock);
});

async function principal(name: string) {
  const email = `${name}@example.test`;
  await auth.provisionCustomer({ email, name, password: "a long isolated lifecycle test password" });
  const login = await auth.login(email, "a long isolated lifecycle test password");
  return auth.requireSession(new Request("https://launchpad.test", { headers: { cookie: login.cookie.split(";")[0] } }));
}

test("second-resolution deauthorization also revokes consent begun later within that second", async () => {
  const owner = await principal("fractional-revocation");
  const attempt = await connections.beginOAuth(owner, oauth);
  const connection = await connections.completeAuthorization(owner, attempt.state, oauth, grant);
  await lifecycle.deauthorize("1001", { eventId: digest("fractional-deauthorization"), issuedAt: Math.floor(clock.getTime() / 1000) });
  assert.equal((await connections.get(owner, connection.id)).status, "REVOKED");
});

test("second-resolution revocation fences an earlier pending callback with fractional timestamp", async () => {
  const owner = await principal("fractional-pending");
  const attempt = await connections.beginOAuth(owner, oauth);
  await lifecycle.deauthorize("1001", { eventId: digest("fractional-pending-deauthorization"), issuedAt: Math.floor(clock.getTime() / 1000) });
  await assert.rejects(connections.completeAuthorization(owner, attempt.state, oauth, grant), { code: "PROVIDER_REVOKED" });
});

test("provider removal cancels only reconnects to its subject and mode, preserving independent pending consent", async () => {
  const owner = await principal("independent-pending-consent");
  const grants = [
    { ...grant, providerUserId: "4101", externalGrantId: "4101" },
    { ...grant, providerUserId: "4202", externalGrantId: "4202" },
    { ...grant, providerUserId: "4303", externalGrantId: "4303", connectionMode: "LIVE" as const },
  ];
  const pending = [];
  for (const verified of grants) {
    const start = await connections.beginOAuth(owner, oauth);
    const connection = await connections.completeAuthorization(owner, start.state, oauth, verified);
    const reconnect = await connections.beginOAuth(owner, { ...oauth, reconnectAuthorizationId: connection.id });
    pending.push({ connection, reconnect, verified });
  }
  const freshRevoked = await connections.beginOAuth(owner, oauth);
  const freshIndependent = await connections.beginOAuth(owner, oauth);
  await lifecycle.deauthorize("4101", { eventId: digest("targeted-pending-removal"),
    issuedAt: Math.floor(clock.getTime() / 1000) });
  await assert.rejects(connections.getOAuthExchangeContext(owner, pending[0].reconnect.state, oauth),
    { code: "INVALID_OAUTH_STATE" });
  for (const independent of pending.slice(1)) {
    assert.equal((await connections.get(owner, independent.connection.id)).status, "CONNECTED");
    const claim = await connections.claimOAuthExchange(owner, independent.reconnect.state, oauth);
    const completed = await connections.completeAuthorization(owner, independent.reconnect.state, oauth,
      independent.verified, claim.exchangeClaimToken);
    assert.equal(completed.id, independent.connection.id);
    assert.equal(completed.status, "CONNECTED");
  }
  // An unbound attempt has no verified subject yet; the completion fence checks
  // the eventual subject without invalidating unrelated new consent.
  await assert.rejects(connections.completeAuthorization(owner, freshRevoked.state, oauth, grants[0]),
    { code: "PROVIDER_REVOKED" });
  assert.equal((await connections.completeAuthorization(owner, freshIndependent.state, oauth,
    { ...grant, providerUserId: "4404", externalGrantId: "4404" })).status, "CONNECTED");
});

after(async () => { await db?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });
