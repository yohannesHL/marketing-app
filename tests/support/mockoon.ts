import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

export async function startMockoon(fixture: string) {
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((done, reject) => reservation.close((e) => e ? reject(e) : done()));
  const require = createRequire(import.meta.url);
  const executable = resolve(dirname(require.resolve("@mockoon/cli/package.json")), "bin/run.js");
  const child = spawn(process.execPath, [executable, "start", "--data", resolve(fixture),
    "--port", String(port), "--hostname", "127.0.0.1", "--disable-log-to-file", "--disable-admin-api"], { stdio: "ignore" });
  const origin = `http://127.0.0.1:${port}`;
  let startupError = false;
  child.on("error", () => { startupError = true; });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((done) => { child.once("exit", () => done()); child.kill("SIGTERM"); });
  };
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (startupError || child.exitCode !== null) break;
    try { if ((await fetch(`${origin}/health`)).ok) return { origin, stop }; }
    catch { /* Wait for the real external fixture server. */ }
    await new Promise((done) => setTimeout(done, 100));
  }
  await stop();
  throw new Error("Mockoon fixture failed to start.");
}
