import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createEmailFixture, EMAIL_FIXTURE_ORIGIN } from "../support/email-fixture";
import { EMAIL_REQUIRED_EVENTS } from "../../apps/web/src/server/email/emailProvider";

const repository = fileURLToPath(new URL("../../", import.meta.url));
async function runWorker(environment: NodeJS.ProcessEnv) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "apps/web/scripts/automation-worker.ts", "run-once"], {
      cwd: repository, env: environment, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 15_000);
    child.stdout.on("data", data => { stdout += String(data); if (stdout.length > 65_536) child.kill("SIGKILL"); });
    child.stderr.on("data", data => { stderr += String(data); if (stderr.length > 65_536) child.kill("SIGKILL"); });
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0 || timedOut) reject(new Error(`Worker failed (${timedOut ? "timeout" : signal ?? code}): ${stdout}\n${stderr}`));
      else resolve({ stdout, stderr });
    });
  });
}
async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
}

test("real automation worker restarts use durable authority after session deletion and never adopt an unstarted manual send", { timeout: 60_000 }, async () => {
  assert.equal(Number(process.versions.node.split(".")[0]), 24, "The application worker runs on Node 24");
  const f = await createEmailFixture();
  let server: Server | undefined;
  try {
    // Use actual wall time for the child process, with stale readiness forcing its real HTTP refresh path.
    f.setNow(new Date(Math.floor(Date.now() / 1000) * 1000 - 20 * 60_000));
    const setup = await f.readyConnection(), definition = f.definition(setup.sender.id);
    definition.sendWindow = { timeZone: "UTC", weekdays: [1, 2, 3, 4, 5, 6, 7], startMinute: 0, endMinute: 1440 };
    const published = await f.publishedCampaign({ setup, definition });
    const scheduled = await f.enrolled({ published, journey: false });
    const manualPerson = await f.recipient({ email: "manual-only@example.test" });
    const manual = await f.enrolled({ published, recipient: manualPerson, journey: false });
    while (await f.funnels.processOnce()) { /* No unrelated matching backlog can hide the persisted send authority. */ }
    const legacy = await f.delivery.createIntent(f.principal, { membershipId: manual.membership.id });
    const legacyBefore = await f.db.messageSend.findUniqueOrThrow({ where: { id: legacy.send.id } });
    assert.equal(legacyBefore.status, "PENDING");
    const started = await f.campaigns.start(f.principal, scheduled.membership.id, { requestKey: randomUUID(), reason: "Start the reviewed worker sequence" });
    await f.db.customerSession.delete({ where: { id: f.principal.sessionId } });
    assert.equal(await f.db.customerSession.count(), 0);

    const received: { method: string; path: string; body: Record<string, unknown> | null; key?: string }[] = [];
    const providerId = randomUUID(), serverErrors: unknown[] = [];
    server = createServer((request, response) => {
      void (async () => {
        assert.equal(request.headers.authorization, `Bearer ${setup.apiKey}`);
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of request) { const buffer = Buffer.from(chunk); bytes += buffer.length; assert.ok(bytes <= 131_072); chunks.push(buffer); }
        const raw = Buffer.concat(chunks).toString("utf8"), path = new URL(request.url!, "http://127.0.0.1").pathname;
        const body = raw ? JSON.parse(raw) as Record<string, unknown> : null;
        const key = request.headers["idempotency-key"];
        received.push({ method: request.method!, path, body, ...(typeof key === "string" ? { key } : {}) });
        const respond = (value: unknown) => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
        if (request.method === "GET" && path === `/domains/${setup.domainId}`) {
          respond({ id: setup.domainId, name: "example.test", status: "verified", capabilities: { sending: "enabled", receiving: "disabled" }, open_tracking: false, click_tracking: true }); return;
        }
        if (request.method === "GET" && path === `/webhooks/${setup.webhookId}`) {
          respond({ id: setup.webhookId, endpoint: setup.webhookUrl, signing_secret: setup.secret, status: "enabled", events: [...EMAIL_REQUIRED_EVENTS] }); return;
        }
        if (request.method === "POST" && path === "/emails") {
          assert.deepEqual(body?.to, [scheduled.contact.email]); assert.equal(body?.subject, published.definition.steps[0].subject); assert.ok(key);
          respond({ id: providerId }); return;
        }
        throw new Error("Unexpected loopback provider operation");
      })().catch(error => { serverErrors.push(error); response.writeHead(500, { "Content-Type": "application/json" }); response.end('{"name":"fixture_error"}'); });
    });
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(0, "127.0.0.1", () => { server!.off("error", reject); resolve(); }); });
    const address = server.address(); assert.ok(address && typeof address !== "string");
    // Do not inherit credentials, NODE_OPTIONS or local dotenv files into this isolated process.
    const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      NODE_ENV: "test", DOTENV_CONFIG_PATH: "/dev/null", DATABASE_URL: f.databaseUrl, APP_ORIGIN: EMAIL_FIXTURE_ORIGIN,
      CONNECTION_TOKEN_KEYS: JSON.stringify({ fixture: Buffer.alloc(32, 17).toString("base64") }), CONNECTION_ACTIVE_KEY_ID: "fixture",
      CONNECTION_MODE: "mock", EMAIL_TEST_PROVIDER_ORIGIN: `http://127.0.0.1:${address.port}`, EMAIL_LIVE_DELIVERY_ENABLED: "false",
      FUNNEL_LIVE_INGRESS_ENABLED: "false", LOCAL_SQLITE_ROLE: "worker", LOCAL_SQLITE_DIAGNOSTICS: "false" };
    const output = [await runWorker(environment)];
    assert.deepEqual(serverErrors, []);
    const accepted = await f.db.messageSend.findFirstOrThrow({ where: { membershipId: scheduled.membership.id } });
    assert.equal(accepted.status, "ACCEPTED"); assert.equal(accepted.providerMessageId, providerId);
    assert.equal((await f.db.campaignStepExecution.findUniqueOrThrow({ where: { id: started.executionId } })).status, "ACCEPTED");
    assert.equal((await f.db.campaignMembership.findUniqueOrThrow({ where: { id: scheduled.membership.id } })).status, "COMPLETED");
    output.push(await runWorker(environment), await runWorker(environment));
    assert.deepEqual(serverErrors, []);
    assert.deepEqual(received.map(item => [item.method, item.path]), [
      ["GET", `/domains/${setup.domainId}`], ["GET", `/webhooks/${setup.webhookId}`], ["POST", "/emails"],
    ]);
    assert.equal(await f.db.messageSend.count({ where: { membershipId: scheduled.membership.id } }), 1);
    assert.equal(await f.db.deliveryAttempt.count({ where: { sendId: accepted.id } }), 1);
    assert.deepEqual(await f.db.messageSend.findUniqueOrThrow({ where: { id: legacy.send.id } }), legacyBefore);
    assert.equal(await f.db.campaignStepExecution.count({ where: { membershipId: manual.membership.id } }), 0);
    assert.equal(await f.db.deliveryAttempt.count({ where: { sendId: legacy.send.id } }), 0);
    assert.equal((await f.db.campaignMembership.findUniqueOrThrow({ where: { id: manual.membership.id } })).status, "ACTIVE");
    const logged = output.map(item => `${item.stdout}\n${item.stderr}`).join("\n");
    for (const privateValue of [setup.apiKey, setup.secret, setup.webhookUrl, scheduled.contact.email!, manual.contact.email!,
      definition.steps[0].subject, accepted.idempotencyKey, accepted.payloadCiphertext!]) assert.ok(!logged.includes(privateValue));
    assert.doesNotMatch(logged, /Bearer|Ciphertext|signing_secret|requestDigest|recipientDigest|subject|payload/);
    assert.ok(output[0].stdout.trim());
    for (const { stdout, stderr } of output) {
      assert.equal(stderr, "");
      for (const line of stdout.trim().split("\n").filter(Boolean)) {
        const status = JSON.parse(line); assert.deepEqual(Object.keys(status).sort(), ["events", "status"]); assert.equal(status.status, "PROCESSED");
        assert.ok(status.events.length);
        for (const phase of status.events) { assert.deepEqual(Object.keys(phase).sort(), ["phase", "status"]); assert.match(phase.phase, /^[a-z-]+$/); assert.match(phase.status, /^[A-Z_]+$/); }
      }
    }
  } finally { if (server) await closeServer(server); await f.close(); }
});
