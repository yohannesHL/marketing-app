import { spawn, type ChildProcess } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { socialAllPlatformFixture } from "./social-all-platform-fixture";

async function main() {
  const origin = process.env.BASE_URL ?? "http://127.0.0.1:3156", parsed = new URL(origin);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/" || parsed.search || parsed.hash || !parsed.port ||
    !process.env.QA_FIXTURE_INFO) throw new Error("Configure an isolated loopback browser fixture.");
  const controller = new AbortController();
  let fixture: Awaited<ReturnType<typeof socialAllPlatformFixture>> | undefined;
  let starting: Promise<Awaited<ReturnType<typeof socialAllPlatformFixture>>> | undefined;
  const processes: ChildProcess[] = [];
  let cleaning = false, cleanupPromise: Promise<void> | undefined;
  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    cleaning = true; controller.abort();
    cleanupPromise = (async () => {
    const owned = fixture ?? await starting?.catch(() => undefined);
    for (const process of processes) if (process.pid && process.exitCode === null) process.kill("SIGTERM");
    await Promise.all(processes.map(process => !process.pid || process.exitCode !== null || process.signalCode !== null ? Promise.resolve() :
      new Promise<void>(resolve => {
        const timer = setTimeout(() => { process.kill("SIGKILL"); resolve(); }, 5000);
        process.once("exit", () => { clearTimeout(timer); resolve(); });
      })));
    await owned?.close();
    await rm(process.env.QA_FIXTURE_INFO!, { force: true });
    })();
    return cleanupPromise;
  };
  process.once("SIGTERM", () => { void cleanup(); }); process.once("SIGINT", () => { void cleanup(); });
  try {
    starting = socialAllPlatformFixture({ origin: parsed.origin, realClock: true, signal: controller.signal });
    fixture = await starting;
    controller.signal.throwIfAborted();
    for (const browser of ["chromium", "firefox", "webkit"]) {
      controller.signal.throwIfAborted();
      await fixture.customer(`qa-${browser}`);
      controller.signal.throwIfAborted();
    }
    controller.signal.throwIfAborted();
    await writeFile(process.env.QA_FIXTURE_INFO, JSON.stringify({ imagePath: fixture.imagePath, videoPath: fixture.videoPath,
      imageBytes: fixture.png.length, videoBytes: fixture.video.length,
      providerOrigins: Object.fromEntries(Object.entries(fixture.mocks).map(([name, mock]) => [name, mock.origin])) }));
    controller.signal.throwIfAborted();
    // This runner always overrides inherited live settings. Only isolated HTTP fixtures are enabled.
    const env = { ...process.env, ...fixture.environment(),
      BASE_URL: parsed.origin, APP_ORIGIN: parsed.origin, INTERNAL_BASE_URL: parsed.origin,
      CONNECTION_MODE: "mock", ADS_MODE: "mock", SOCIAL_PUBLISHING_ENABLED: "true",
      SOCIAL_APPROVED_PROVIDERS: JSON.stringify(fixture.config.approvedProviders),
      LOCAL_SQLITE_DIAGNOSTICS: "true", X_API_OWNER_BUDGETS: JSON.stringify(fixture.xOwnerPolicies), PORT: parsed.port, NODE_ENV: "production" };
    controller.signal.throwIfAborted();
    const build = spawn("npm", ["--workspace", "@launchpad/web", "run", "build"], { env, stdio: "inherit" }); processes.push(build);
    if (await new Promise<number | null>((resolve, reject) => { build.once("exit", resolve); build.once("error", reject); }) !== 0)
      throw new Error("Isolated delivery app build failed.");
    controller.signal.throwIfAborted();
    const server = spawn(process.execPath, ["server.js"], { cwd: join(process.cwd(), "apps/web"), env: { ...env, LOCAL_SQLITE_ROLE: "web" }, stdio: "inherit" }); processes.push(server);
    server.once("exit", code => { if (!cleaning) { process.exitCode = code ?? 1; void cleanup(); } });
    server.once("error", () => { process.exitCode = 1; void cleanup(); });
    const worker = spawn(process.execPath, ["--import", "tsx", "apps/web/scripts/social-worker.ts", "run"], { env: { ...env, LOCAL_SQLITE_ROLE: "worker" }, stdio: "inherit" }); processes.push(worker);
    worker.once("exit", code => { if (!cleaning) { process.exitCode = code ?? 1; void cleanup(); } });
    worker.once("error", () => { process.exitCode = 1; void cleanup(); });
  } catch (error) { await cleanup(); throw error; }
}
main().catch(() => { console.error("Isolated mock social-delivery setup stopped."); process.exitCode = 1; });
