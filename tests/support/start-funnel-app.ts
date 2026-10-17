import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { createEmailFixture, EMAIL_FIXTURE_ORIGIN, type EmailFixture } from "./email-fixture";
import { EMAIL_REQUIRED_EVENTS } from "../../apps/web/src/server/email/emailProvider";
import type { FunnelDefinition } from "../../apps/web/src/server/funnels/funnelDefinition";
import { FunnelReportingService } from "../../apps/web/src/server/funnels/funnelReportingService";

export type FunnelBrowserCustomer = {
  email: string; password: string; connectionId: string; senderId: string; sourceId: string;
  campaignId: string; contactId: string; subjectIds: string[]; funnelId: string;
};
export type FunnelBrowserReportCustomer = {
  email: string; password: string; salesFunnelId: string; salesVersion1Id: string; salesVersion2Id: string;
  salesSubjectIds: string[]; salesJourneyIds: string[]; purchaseFunnelId: string; purchaseVersionId: string;
  boardFunnelId: string; boardVersionId: string; fromInclusive: string; toExclusive: string; allTo: string;
};
export type FunnelBrowserFixtureInfo = { customers: Record<string, FunnelBrowserCustomer>; reports: Record<string, FunnelBrowserReportCustomer> };

async function reportingCustomer(f: EmailFixture, browser: string, wallTime: Date, signal: AbortSignal) {
  const day = 86_400_000, midnight = Date.UTC(wallTime.getUTCFullYear(), wallTime.getUTCMonth(), wallTime.getUTCDate());
  const at = (days: number, hour = 0) => new Date(midnight + days * day + hour * 3_600_000);
  f.setNow(at(-3, 8));
  const email = `reports-${browser}@example.test`, password = "Fixture-only-2026!";
  await f.auth.provisionCustomer({ email, name: "Reporting browser fixture", password });
  const login = await f.auth.login(email, password);
  const principal = await f.auth.requireSession(new Request(EMAIL_FIXTURE_ORIGIN, { headers: { cookie: login.cookie.split(";")[0] } }));
  const setup = await f.readyConnection(principal), published = await f.publishedCampaign({ principal, setup });
  const secret = `reporting-fixture-${randomUUID()}`;
  const { source } = await f.tracking.createSource(principal, { name: "Reporting CRM", provider: "API", environment: "TEST", externalAccountId: `reporting-${browser}`,
    credentials: { signingSecret: secret }, config: { allowedEvents: ["enquiry.accepted"], propertyKeys: ["utm_campaign"] } });
  async function drain() {
    while (await f.tracking.processOnce()) signal.throwIfAborted();
    while (await f.funnels.processOnce()) signal.throwIfAborted();
  }
  async function enquiry(id: string, contactId: string, tagged = false) {
    const raw = JSON.stringify({ schemaVersion: 1, type: "enquiry.accepted", occurredAt: f.now().toISOString(), resource: { kind: "ENQUIRY", id }, subjectKind: "SALES",
      contactIdentity: { kind: "CRM_CONTACT", id: contactId }, contact: { email: contactId === "maya" ? "maya@example.test" : `${contactId}@example.test`, name: contactId === "maya" ? "Maya" : contactId },
      properties: tagged ? { utm_campaign: "consultation" } : {} });
    const timestamp = String(f.now().getTime() / 1000), requestId = randomUUID();
    const receipt = await f.tracking.collectApi(source.id, new Headers({ "x-launchpad-id": requestId, "x-launchpad-timestamp": timestamp,
      "x-launchpad-signature": createHmac("sha256", secret).update(`${timestamp}.${requestId}.${raw}`).digest("hex") }), raw);
    await drain(); const event = await f.db.trackingEvent.findUniqueOrThrow({ where: { id: receipt.receipts[0].id } });
    assert.equal(event.status, "MATCHED"); assert.ok(event.subjectId); return event.subjectId;
  }
  const definition: FunnelDefinition = { schemaVersion: 1,
    stages: [{ id: "lead", name: "Lead", goal: false, terminal: "NONE" },
      // Qualified is a goal milestone, independent of a terminal successful exit.
      { id: "qualified", name: "Discovery booked", goal: true, terminal: "NONE" },
      { id: "won", name: "Client onboarded", goal: true, terminal: "SUCCESS" }],
    entryStages: ["lead"], routes: [], campaignLinks: [{ id: "observed-campaign", stageId: "lead", campaignId: published.campaign.id, purpose: "ATTRIBUTION" }] };
  const sales = await f.funnels.create(principal, { name: "Reporting consultation journey", environment: "TEST", subjectKind: "SALES", definition });
  const v1 = await f.funnels.publish(principal, sales.id, { draftRevision: sales.draftRevision });
  const move = (subjectId: string, stageId: string, newCycle = false) => f.funnels.move(principal, sales.id, { subjectId, stageId, newCycle,
    reason: "Reporting fixture: customer-confirmed progress", commandKey: randomUUID() });
  f.setNow(at(-3, 10)); const a = await enquiry("enquiry-a", "maya", true), b = await enquiry("enquiry-b", "maya");
  await move(a, "lead"); await move(b, "lead");
  f.setNow(at(-3, 11)); await move(a, "qualified");
  f.setNow(at(-3, 12)); await move(a, "won");
  f.setNow(at(-3, 13)); await move(a, "lead", true);
  f.setNow(at(-3, 14)); await move(a, "qualified");
  f.setNow(at(-2)); const c = await enquiry("enquiry-c", "boundary-contact"); await move(c, "lead");
  f.setNow(at(-1));
  const nextDefinition = { ...definition, stages: definition.stages.map(stage => stage.id === "lead" ? { ...stage, name: "New enquiry" } : stage) };
  const updated = await f.funnels.updateDraft(principal, sales.id, { draftRevision: sales.draftRevision, definition: nextDefinition });
  const v2 = await f.funnels.publish(principal, sales.id, { draftRevision: updated.draftRevision });
  f.setNow(at(-1, 10)); const d = await enquiry("enquiry-d", "latest-contact"); await move(d, "lead");

  const shop = await f.tracking.createSource(principal, { name: "Reporting test store", provider: "SHOPIFY", environment: "TEST", externalAccountId: "reporting-fixture.myshopify.com", credentials: { signingSecret: secret } });
  const purchaseDefinition: FunnelDefinition = { schemaVersion: 1,
    stages: [{ id: "paid", name: "Paid order", goal: true, terminal: "NONE" }, { id: "refunded", name: "Refund recorded", goal: false, terminal: "NONE" }], entryStages: ["paid"],
    routes: [{ id: "paid-entry", from: null, trigger: { kind: "EVENT", sourceId: shop.source.id, type: "order.paid" }, branches: [{ id: "paid", to: "paid" }], fallback: { kind: "WAIT" } },
      { id: "refund", from: "paid", trigger: { kind: "EVENT", sourceId: shop.source.id, type: "refund.succeeded" }, branches: [{ id: "refunded", to: "refunded" }], fallback: { kind: "WAIT" } }] };
  const purchase = await f.funnels.create(principal, { name: "Reporting purchase journey", environment: "TEST", subjectKind: "PURCHASE", definition: purchaseDefinition });
  const purchaseVersion = await f.funnels.publish(principal, purchase.id, { draftRevision: purchase.draftRevision });
  async function hook(payload: unknown, topic: string) {
    const raw = JSON.stringify(payload);
    await f.tracking.collectHook(shop.ingressToken!, new Headers({ "X-Shopify-Hmac-SHA256": createHmac("sha256", secret).update(raw).digest("base64"),
      "X-Shopify-Topic": topic, "X-Shopify-Shop-Domain": "reporting-fixture.myshopify.com", "X-Shopify-Webhook-Id": randomUUID(), "X-Shopify-API-Version": "2026-10" }), raw);
    await drain();
  }
  f.setNow(at(-1, 11));
  const order = (id: string, amount: string, currency: string) => ({ id, admin_graphql_api_id: `gid://shopify/Order/${id}`, financial_status: "paid", test: true,
    updated_at: f.now().toISOString(), checkout_token: `reporting-checkout-${id}`, customer: { id: "550", admin_graphql_api_id: "gid://shopify/Customer/550", email: "buyer@example.test", first_name: "Buyer" },
    total_price_set: { shop_money: { amount, currency_code: currency }, presentment_money: { amount, currency_code: currency } } });
  const paid1 = order("101", "0.1", "GBP");
  await hook(paid1, "orders/paid"); await hook(order("102", "0.2", "GBP"), "orders/paid"); await hook(order("103", "1.234567", "USD"), "orders/paid");
  f.setNow(at(-1, 12));
  const refund = { id: "301", order_id: "101", created_at: f.now().toISOString(), processed_at: f.now().toISOString(), transactions: [
    { id: "401", order_id: "101", kind: "refund", status: "success", test: true, amount: "0.1", currency: "GBP", created_at: f.now().toISOString(), processed_at: f.now().toISOString() }] };
  await hook(refund, "refunds/create"); await hook(paid1, "orders/paid"); await hook(refund, "refunds/create");

  const board = await f.funnels.create(principal, { name: "Reporting full stage board", environment: "TEST", subjectKind: "SALES",
    definition: { schemaVersion: 1, stages: [{ id: "waiting", name: "Waiting enquiries", goal: false, terminal: "NONE" }], entryStages: ["waiting"], routes: [] } });
  const boardVersion = await f.funnels.publish(principal, board.id, { draftRevision: board.draftRevision });
  f.setNow(at(-1, 13));
  for (let index = 1; index <= 51; index++) {
    signal.throwIfAborted(); const subjectId = await enquiry(`board-enquiry-${index}`, `board-person-${index}`);
    await f.funnels.move(principal, board.id, { subjectId, stageId: "waiting", reason: "Reporting fixture: independently confirmed enquiry", commandKey: randomUUID() });
  }
  const salesJourneys = await f.db.funnelJourney.findMany({ where: { funnelId: sales.id } });
  assert.equal(salesJourneys.length, 5);
  assert.equal(salesJourneys.filter(journey => journey.versionId === v1.version.id).length, 4);
  assert.equal(await f.db.funnelJourney.count({ where: { funnelId: purchase.id } }), 3);
  assert.equal(await f.db.trackingFact.count({ where: { ownerId: principal.userId, type: "refund.succeeded" } }), 1);
  assert.equal(await f.db.funnelJourney.count({ where: { funnelId: board.id } }), 51);
  assert.equal(await f.db.campaignMembership.count({ where: { ownerId: principal.userId } }), 0);
  assert.equal(await f.db.messageSend.count({ where: { ownerId: principal.userId } }), 0);
  f.setNow(wallTime);
  if (process.env.QA_FUNNEL_FIXTURE_CHECK === "1") {
    const reports = new FunnelReportingService(f.db, f.auth);
    const salesReport = await reports.report(principal, sales.id, { versionId: v1.version.id, from: at(-3).toISOString(), to: at(-2).toISOString() });
    assert.equal(salesReport.totals.journeys, 3); assert.equal(salesReport.totals.goalJourneys, 2);
    assert.equal(salesReport.attribution.unknownSubjects, 1); assert.equal(salesReport.attribution.partialSubjects, 1);
    const purchaseReport = await reports.report(principal, purchase.id, { versionId: purchaseVersion.version.id, from: at(-3).toISOString(), to: wallTime.toISOString() });
    assert.deepEqual(purchaseReport.money.currencies.map(currency => [currency.currency, currency.grossPaid.amount, currency.successfulRefunds.amount, currency.netObservedCash]),
      [["GBP", "0.3", "0.1", "0.2"], ["USD", "1.234567", "0", "1.234567"]]);
  }
  const info: FunnelBrowserReportCustomer = { email, password, salesFunnelId: sales.id, salesVersion1Id: v1.version.id, salesVersion2Id: v2.version.id,
    salesSubjectIds: [a, b, c, d], salesJourneyIds: salesJourneys.map(journey => journey.id), purchaseFunnelId: purchase.id, purchaseVersionId: purchaseVersion.version.id,
    boardFunnelId: board.id, boardVersionId: boardVersion.version.id, fromInclusive: at(-3).toISOString(), toExclusive: at(-2).toISOString(), allTo: wallTime.toISOString() };
  return { info, setup };
}

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
    const wallTime = new Date(Math.floor(Date.now() / 1_000) * 1_000); f.setNow(wallTime);
    const accounts = new Map<string, Awaited<ReturnType<EmailFixture["readyConnection"]>>>();
    const info: FunnelBrowserFixtureInfo = { customers: {}, reports: {} };
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
    for (const browser of ["chromium", "firefox", "webkit"]) {
      const report = await reportingCustomer(f, browser, wallTime, controller.signal);
      info.reports[browser] = report.info; accounts.set(report.setup.apiKey, report.setup);
    }
    if (process.env.QA_FUNNEL_FIXTURE_CHECK === "1") { console.log("Reporting fixtures verified: 3 owners; each has 5 sales cycles, 3 purchase journeys, 51 board journeys and zero sends."); await cleanup(); return; }
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
main().catch(error => {
  console.error("Isolated funnel browser setup stopped.");
  if (process.env.QA_FUNNEL_FIXTURE_CHECK === "1") console.error({ name: error.name, code: error.code, message: error.message });
  process.exitCode = 1;
});
