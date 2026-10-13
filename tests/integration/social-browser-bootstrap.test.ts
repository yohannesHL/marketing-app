import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const run = promisify(execFile);
async function processes() {
  const { stdout } = await run("ps", ["-axo", "pid=,ppid=,command="]);
  return stdout.split("\n").flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3] }] : [];
  });
}

test("terminating browser setup during real provider startup cleans every child without starting the app", { timeout: 45000 }, async () => {
  const info = join(tmpdir(), `social-abort-${randomUUID()}.json`);
  const child = spawn(process.execPath, ["--import", "tsx", "tests/support/start-social-delivery-app.ts"], {
    env: { ...process.env, BASE_URL: "http://127.0.0.1:3199", QA_FIXTURE_INFO: info }, stdio: "ignore",
  });
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  let directory = "", observed: number[] = [];
  try {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      assert.equal(child.exitCode, null, "Setup exited before the observed cancellation phase");
      const providers = (await processes()).filter(value => value.parent === child.pid && value.command.includes("--data") && value.command.includes("social-all-platforms-"));
      if (providers.length) {
        const path = providers[0].command.match(/--data\s+(\S+\/social-all-platforms-[^/\s]+)\//)?.[1];
        assert.ok(path); directory = path; observed = providers.map(value => value.pid); break;
      }
      await delay(25);
    }
    assert.ok(directory, "Actual provider startup must be observed before cancellation");
    await assert.rejects(stat(info), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    child.kill("SIGTERM");
    const timeout = Symbol("timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      assert.notEqual(await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve(timeout), 20000); })]),
        timeout, "Aborted setup must finish cleanup");
    } finally { clearTimeout(timer); }
    assert.deepEqual((await processes()).filter(value => value.command.includes(directory)), [], "No provider or late app process may survive");
    for (const pid of observed) assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
    await assert.rejects(stat(directory), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    await assert.rejects(stat(info), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (directory) {
      for (const value of (await processes()).filter(value => value.command.includes(directory))) try { process.kill(value.pid, "SIGTERM"); } catch {}
      await rm(directory, { recursive: true, force: true });
    }
    await rm(info, { force: true });
  }
});
