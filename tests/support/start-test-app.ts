import { applyConnectionMigrations } from "./test-database";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../../apps/web/src/generated/prisma/client";
import { CustomerAuth } from "../../apps/web/src/server/auth/customerAuth";
import { CustomerConnections } from "../../apps/web/src/server/connections/customerConnections";
import { CredentialVault } from "../../apps/web/src/server/security/credentialVault";
import { startMockoon } from "./mockoon";

async function main() {
  const directory = await mkdtemp(join(tmpdir(), "launchpad-e2e-"));
  const url = `file:${join(directory, "test.db")}`;
  const origin = process.env.BASE_URL ?? "http://127.0.0.1:3000";
  const client = createClient({ url });
  await applyConnectionMigrations(client);
  client.close();
  const db = new PrismaClient({ adapter: new PrismaLibSql({ url }) });
  const auth = new CustomerAuth(db, { origin });
  const tokenKey = randomBytes(32).toString("base64");
  const connections = new CustomerConnections(db, auth, new CredentialVault({ test: tokenKey }, "test"));
  for (const project of ["chromium", "firefox", "webkit"]) {
    for (const prefix of ["e2e", "other", "connections", "social", "youtube", "meta-social", "tiktok", "linkedin"])
      await auth.provisionCustomer({
        email: `${prefix}-${project}@example.test`,
        name: "Test customer",
        password: "isolated-test-password-for-fixtures",
      });
    // Domain/UI fixture only: a synthetic publishing grant, with no registered
    // publishing SDK or provider approval. Enqueue remains disabled.
    const login = await auth.login(`social-${project}@example.test`, "isolated-test-password-for-fixtures");
    const principal = await auth.requireSession(new Request(origin, { headers: { cookie: login.cookie.split(";")[0] } }));
    const oauth = { provider: "LINKEDIN" as const, capability: "SOCIAL" as const,
      scopes: ["openid", "profile", "w_member_social"], redirectUri: `${origin}/api/connections/linkedin/callback`, pkce: false };
    const attempt = await connections.beginOAuth(principal, oauth);
    const grant = await connections.completeAuthorization(principal, attempt.state, oauth, {
      providerUserId: `fixture-member-${project}`, accessToken: `fixture-social-${project}`,
      scopes: oauth.scopes, expiresAt: new Date(Date.now() + 3600_000), connectionMode: "MOCK",
    });
    const destination = await connections.registerDestination(principal, grant.id, {
      kind: "LINKEDIN_MEMBER", externalId: `urn:li:person:fixture-${project}`, name: "Fixture LinkedIn member",
    });
    await db.connectionDestination.update({ where: { id: destination.id }, data: {
      selected: true, available: true, metadata: { canRead: true, canWrite: "ALLOWED" }, lastCheckedAt: new Date(),
    } });
  }
  await db.$disconnect();
  const google = await startMockoon("tests/mockoon/google-ads.json");
  let meta: Awaited<ReturnType<typeof startMockoon>>;
  try { meta = await startMockoon("tests/mockoon/meta-ads.json"); }
  catch (error) {
    await google.stop();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  let youtube: Awaited<ReturnType<typeof startMockoon>>;
  try { youtube = await startMockoon("tests/mockoon/youtube.json"); }
  catch (error) {
    await Promise.all([google.stop(), meta.stop()]);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  let metaPublishing: Awaited<ReturnType<typeof startMockoon>>;
  try { metaPublishing = await startMockoon("tests/mockoon/meta-publishing.json"); }
  catch (error) {
    await Promise.all([google.stop(), meta.stop(), youtube.stop()]);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  let tiktok: Awaited<ReturnType<typeof startMockoon>>;
  try { tiktok = await startMockoon("tests/mockoon/tiktok.json"); }
  catch (error) {
    await Promise.all([google.stop(), meta.stop(), youtube.stop(), metaPublishing.stop()]);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  let linkedin: Awaited<ReturnType<typeof startMockoon>>;
  try { linkedin = await startMockoon("tests/mockoon/linkedin.json"); }
  catch (error) {
    await Promise.all([google.stop(), meta.stop(), youtube.stop(), metaPublishing.stop(), tiktok.stop()]);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const cleanup = async () => {
    await Promise.all([google.stop(), meta.stop(), youtube.stop(), metaPublishing.stop(), tiktok.stop(), linkedin.stop()]);
    await rm(directory, { recursive: true, force: true });
  };
  const env = {
    ...process.env,
    DATABASE_URL: url,
    APP_ORIGIN: origin,
    BASE_URL: origin,
    INTERNAL_BASE_URL: origin,
    ADS_MODE: "mock",
    CONNECTION_MODE: "mock",
    GOOGLE_ADS_MOCKOON_URL: google.origin,
    META_ADS_MOCKOON_URL: meta.origin,
    YOUTUBE_MOCKOON_URL: youtube.origin,
    META_PUBLISHING_MOCKOON_URL: metaPublishing.origin,
    TIKTOK_MOCKOON_URL: tiktok.origin,
    TIKTOK_VERIFIED_MEDIA_PREFIX: `${origin}/api/social/media/`,
    TIKTOK_APP_AUDITED: "false",
    LINKEDIN_MOCKOON_URL: linkedin.origin,
    LINKEDIN_SCOPES: JSON.stringify(["openid", "profile", "w_member_social", "r_member_social", "w_organization_social", "rw_organization_admin", "r_organization_social"]),
    LINKEDIN_MDP_REFRESH_ENABLED: "false",
    SOCIAL_PUBLISHING_ENABLED: "false",
    SOCIAL_APPROVED_PROVIDERS: "[]",
    SOCIAL_MEDIA_DIRECTORY: join(directory, "media"),
    SOCIAL_MEDIA_PUBLIC_ORIGIN: origin,
    SOCIAL_MEDIA_SIGNING_KEY: randomBytes(32).toString("base64"),
    CONNECTION_ACTIVE_KEY_ID: "test",
    CONNECTION_TOKEN_KEYS: JSON.stringify({
      test: tokenKey,
    }),
    PORT: new URL(origin).port || "3000",
    NODE_ENV: "production",
  };
  const build = spawn(
    "npm",
    ["--workspace", "@launchpad/web", "run", "build"],
    { env, stdio: "inherit" },
  );
  const built = await new Promise<number | null>((resolve) =>
    build.once("exit", resolve),
  );
  if (built !== 0) {
    await cleanup();
    process.exitCode = built ?? 1;
    return;
  }
  const server = spawn(process.execPath, ["server.js"], {
    cwd: join(process.cwd(), "apps/web"),
    env,
    stdio: "inherit",
  });
  const stop = () => server.kill("SIGTERM");
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  server.once("exit", async (code) => {
    await cleanup();
    process.exitCode = code ?? 0;
  });
}

main().catch(() => {
  console.error("Isolated test application setup failed.");
  process.exitCode = 1;
});
