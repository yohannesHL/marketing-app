import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { createEmailFixture, EMAIL_FIXTURE_ORIGIN, type EmailFixture } from "./email-fixture";
import { EMAIL_REQUIRED_EVENTS } from "../../apps/web/src/server/email/emailProvider";
import type { FunnelDefinition } from "../../apps/web/src/server/funnels/funnelDefinition";

export type FunnelBrowserCustomer = {
  email: string; password: string; connectionId: string; senderId: string; sourceId: string;
  campaignId: string; contactId: string; subjectIds: string[]; funnelId: string;
};
export type FunnelBrowserFixtureInfo = { customers: Record<string, FunnelBrowserCustomer> };

function loopback(value: string) {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/" || url.search || url.hash || url.username || url.password)
    throw new Error("The browser app and provider must use explicit loopback origins.");
  return url;
}

async function main() {
  const app = loopback(process.env.BASE_URL ?? "http://127.0.0.1:3167");
  const provider = loopback(process.env.QA_FUNNEL_PROVIDER_ORIGIN ?? "http://127.0.0.1:3168");
  const infoPath = process.env.QA_FUNNEL_FIXTURE_INFO;
  if (!infoPath || app.origin === provider.origin) throw new Error("Configure separate, isolated browser fixtures.");
  const controller = new AbortController(), processes: ChildProcess[] = [];
  let fixture: EmailFixture | undefined, starting: Promise<EmailFixture> | undefined, server: Server | undefined;
  let cleaning = false, cleanupPromise: Promise<void> | undefined;
  function cleanup() {
    if (cleanupPromise) return cleanupPromise;
    cleaning = true; controller.abort();
    cleanupPromise = (async () => {
      const owned = fixture ?? await starting?.catch(() => undefined);
      for (const child of processes) if (child.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await Promise.all(processes.map(child => !child.pid || child.exitCode !== null || child.signalCode !== null ? Promise.resolve() :
        new Promise<void>(resolve => { const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5_000);
          child.once("exit", () => { clearTimeout(timer); resolve(); }); })));
      if (server?.listening) await new Promise<void>(resolve => { server!.close(() => resolve()); server!.closeAllConnections(); });
      await owned?.close(); await rm(infoPath!, { force: true });
    })();
    return cleanupPromise;
  }
  process.once("SIGTERM", () => { void cleanup(); }); process.once("SIGINT", () => { void cleanup(); });
  try {
    starting = createEmailFixture(); fixture = await starting; controller.signal.throwIfAborted();
    const f = fixture;
    f.setNow(new Date(Math.floor(Date.now() / 1_000) * 1_000));
    const accounts = new Map<string, Awaited<ReturnType<EmailFixture["readyConnection"]>>>();
    const info: FunnelBrowserFixtureInfo = { customers: {} };
    for (const browser of ["chromium", "firefox", "webkit"]) for (const feature of ["funnels", "email", "tracking"]) {
      controller.signal.throwIfAborted();
      const key = `${feature}-${browser}`, email = `${key}@example.test`, password = "Fixture-only-2026!";
      await f.auth.provisionCustomer({ email, name: `${feature} browser fixture`, password });
      const session = await f.auth.login(email, password);
      const principal = await f.auth.requireSession(new Request(EMAIL_FIXTURE_ORIGIN, { headers: { cookie: session.cookie.split(";")[0] } }));
      const setup = await f.readyConnection(principal); accounts.set(setup.apiKey, setup);
      const first = await f.recipient({ principal, contactExternalId: `maya-${key}`, subjectExternalId: `enquiry-one-${key}` });
      const second = await f.recipient({ principal, contactExternalId: `maya-${key}`, subjectExternalId: `enquiry-two-${key}` });
      await f.tracking.updateSource(principal, first.source.id, { config: { allowedEvents: ["enquiry.accepted", "deal.won"], propertyKeys: ["score", "interest"] } });
      const campaignDefinition = f.definition(setup.sender.id);
      // Browser exercises are independent of the real weekday and wall clock.
      campaignDefinition.sendWindow = { timeZone: "UTC", weekdays: [1, 2, 3, 4, 5, 6, 7], startMinute: 0, endMinute: 1440 };
      const published = await f.publishedCampaign({ principal, setup, definition: campaignDefinition });
      const definition: FunnelDefinition = { schemaVersion: 1,
        stages: [{ id: "lead", name: "Lead", goal: false, terminal: "NONE" },
          { id: "qualified", name: "Discovery booked", goal: true, terminal: "NONE" },
          { id: "won", name: "Client onboarded", goal: true, terminal: "SUCCESS" }],
        entryStages: ["lead"], routes: [] };
      const funnel = await f.funnels.create(principal, { name: "Consultation journey", environment: "TEST", subjectKind: "SALES", definition });
      await f.funnels.publish(principal, funnel.id, { draftRevision: funnel.draftRevision });
      for (const person of [first, second]) await f.funnels.move(principal, funnel.id, { subjectId: person.subject.id, stageId: "lead", reason: "Browser fixture: separately confirmed enquiry", commandKey: randomUUID() });
      info.customers[key] = { email, password, connectionId: setup.connection.id, senderId: setup.sender.id, sourceId: first.source.id,
        campaignId: published.campaign.id, contactId: first.contact.id, subjectIds: [first.subject.id, second.subject.id], funnelId: funnel.id };
      if (feature === "tracking") {
        const { source } = await f.tracking.createSource(principal, { name: "Unmatched website observation", provider: "NATIVE", environment: "TEST", externalAccountId: `website-${key}`,
          config: { allowedEvents: ["page.viewed", "enquiry.accepted"], propertyKeys: ["path"], allowedOrigins: [app.origin] } });
        const visit = await f.tracking.visitor(source.id, app.origin);
        await f.tracking.collectNative(source.id, app.origin, JSON.stringify({ schemaVersion: 1, eventId: randomUUID(), visitorToken: visit.visitorToken, type: "page.viewed", properties: { path: "/services" } }), false);
        await f.tracking.processOnce();
      }
    }
    while (await f.funnels.processOnce()) { controller.signal.throwIfAborted(); }
    const accepted = new Map<string, { id: string; raw: string; accountId: string; record: Record<string, unknown> }>();
    const stats = { readinessReads: 0, sendRequests: 0, acceptedSends: 0, retrievalReads: 0 };
    server = createServer((request, response) => {
      const reply = (status: number, body: unknown) => { response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify(body)); };
      void (async () => {
        const path = new URL(request.url!, provider.origin).pathname;
        if (request.method === "GET" && path === "/__stats") { reply(200, stats); return; }
        const token = request.headers.authorization?.replace(/^Bearer /, ""), account = accounts.get(token ?? "");
        if (!account) { reply(401, { name: "validation_error" }); return; }
        if (request.method === "GET" && path === `/domains/${account.domainId}`) { stats.readinessReads++;
          reply(200, { id: account.domainId, name: account.account.domain, status: "verified", capabilities: { sending: "enabled", receiving: "disabled" }, open_tracking: false, click_tracking: true }); return; }
        if (request.method === "GET" && path === `/webhooks/${account.webhookId}`) { stats.readinessReads++;
          reply(200, { id: account.webhookId, endpoint: account.webhookUrl, signing_secret: account.secret, status: "enabled", events: [...EMAIL_REQUIRED_EVENTS] }); return; }
        if (request.method === "GET" && path.startsWith("/emails/")) { stats.retrievalReads++;
          const item = [...accepted.values()].find(value => value.id === path.slice(8) && value.accountId === account.connection.id);
          reply(item ? 200 : 404, item?.record ?? { name: "not_found" }); return; }
        if (request.method !== "POST" || path !== "/emails") { reply(404, { name: "not_found" }); return; }
        stats.sendRequests++;
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 131_072) { reply(413, { name: "validation_error" }); return; } chunks.push(bytes); }
        const raw = Buffer.concat(chunks).toString("utf8"), payload = JSON.parse(raw), idempotencyKey = request.headers["idempotency-key"];
        if (typeof idempotencyKey !== "string" || !Array.isArray(payload.to) || payload.to.length !== 1) { reply(400, { name: "validation_error" }); return; }
        const key = `${account.connection.id}:${idempotencyKey}`, prior = accepted.get(key);
        if (prior) { reply(prior.raw === raw ? 200 : 409, prior.raw === raw ? { id: prior.id } : { name: "invalid_idempotent_request" }); return; }
        const id = randomUUID(); stats.acceptedSends++;
        accepted.set(key, { id, raw, accountId: account.connection.id, record: { id, from: payload.from, to: payload.to, subject: payload.subject,
          html: payload.html ?? null, text: payload.text ?? null, reply_to: payload.reply_to ?? [], cc: [], bcc: [], tags: payload.tags, created_at: new Date().toISOString(), last_event: "sent" } });
        reply(200, { id });
      })().catch(() => { if (!response.headersSent) reply(500, { name: "fixture_error" }); else response.end(); });
    });
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(Number(provider.port), "127.0.0.1", () => { server!.off("error", reject); resolve(); }); });
    controller.signal.throwIfAborted();
    await writeFile(infoPath, JSON.stringify(info), { mode: 0o600 });
    // Whitelist process environment. No user credentials, NODE_OPTIONS, or live transport flags are inherited.
    const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CI: process.env.CI,
      NODE_ENV: process.env.QA_FUNNEL_DEV === "1" ? "development" : "production", DOTENV_CONFIG_PATH: "/dev/null", NEXT_TELEMETRY_DISABLED: "1",
      DATABASE_URL: f.databaseUrl, APP_ORIGIN: app.origin, BASE_URL: app.origin, INTERNAL_BASE_URL: app.origin, PORT: app.port,
      CONNECTION_TOKEN_KEYS: JSON.stringify({ fixture: Buffer.alloc(32, 17).toString("base64") }), CONNECTION_ACTIVE_KEY_ID: "fixture",
      CONNECTION_MODE: "mock", ADS_MODE: "mock", EMAIL_TEST_PROVIDER_ORIGIN: provider.origin,
      EMAIL_LIVE_DELIVERY_ENABLED: "false", FUNNEL_LIVE_INGRESS_ENABLED: "false", SOCIAL_PUBLISHING_ENABLED: "false",
      LOCAL_SQLITE_DIAGNOSTICS: "false", LOCAL_SQLITE_ROLE: "web" };
    if (environment.NODE_ENV === "production") {
      const build = spawn("npm", ["--workspace", "@launchpad/web", "run", "build"], { env: environment, stdio: "inherit" }); processes.push(build);
      if (await new Promise<number | null>((resolve, reject) => { build.once("exit", resolve); build.once("error", reject); }) !== 0) throw new Error("Browser app build failed.");
    }
    controller.signal.throwIfAborted();
    const child = spawn(process.execPath, ["server.js"], { cwd: join(process.cwd(), "apps/web"), env: environment, stdio: "inherit" }); processes.push(child);
    child.once("exit", code => { if (!cleaning) { process.exitCode = code ?? 1; void cleanup(); } });
    child.once("error", () => { process.exitCode = 1; void cleanup(); });
  } catch (error) { await cleanup(); throw error; }
}
main().catch(() => { console.error("Isolated funnel browser setup stopped."); process.exitCode = 1; });
