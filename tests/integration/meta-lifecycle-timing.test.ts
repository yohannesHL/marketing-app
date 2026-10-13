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

after(async () => { await db?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });
