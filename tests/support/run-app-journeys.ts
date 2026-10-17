import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { constants, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type AppJourneyRun = {
  name: string;
  args: string[];
  environment: Record<string, string>;
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const browsers = new Set(["chromium", "firefox", "webkit"]);

/** Local invocations retain their existing file/grep selection. CI also gates funnels. */
export function buildAppJourneyPlan(args: string[], ci: boolean): AppJourneyRun[] {
  const original: AppJourneyRun = {
    name: "Customer app journeys",
    args: ["test", "--config=playwright.config.ts", ...args],
    environment: {},
  };
  if (!ci) return [original];

  const projects: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument !== "--project" && !argument.startsWith("--project=")) continue;
    const project = argument === "--project" ? args[++index] : argument.slice("--project=".length);
    if (!project || !browsers.has(project)) {
      throw new Error("CI app journeys require --project chromium, firefox or webkit.");
    }
    projects.push(`--project=${project}`);
  }
  // Discovery/help must never turn into a browser run in the additional suite.
  const discovery = args.filter(argument => ["--list", "--help", "-h"].includes(argument));
  return [original, {
    name: "Funnel, tracking and email workspaces",
    args: ["test", "--config=playwright.funnels.config.ts", ...projects, ...discovery],
    environment: {
      BASE_URL: "http://127.0.0.1:3167",
      QA_FUNNEL_PROVIDER_ORIGIN: "http://127.0.0.1:3168",
      QA_FUNNEL_FIXTURE_INFO: join(tmpdir(), `launchpad-funnel-ci-${process.pid}.json`),
      QA_FUNNEL_DEV: "0",
      // The existing workflow uploads test-results/. Keep this beside, rather
      // than inside, the funnel outputDir that Playwright cleans before a run.
      PLAYWRIGHT_HTML_OUTPUT_DIR: join(root, "test-results/funnels-report"),
    },
  }];
}

/** No later build/test process starts after an earlier failure. */
export async function executeAppJourneyPlan(
  plan: AppJourneyRun[],
  run: (step: AppJourneyRun) => Promise<number>,
): Promise<number> {
  for (const step of plan) {
    const code = await run(step);
    if (!Number.isInteger(code) || code < 0 || code > 255) throw new Error("Invalid browser process exit status.");
    if (code !== 0) return code;
  }
  return 0;
}

async function main(): Promise<number> {
  const plan = buildAppJourneyPlan(process.argv.slice(2), Boolean(process.env.CI));
  const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
  let child: ReturnType<typeof spawn> | undefined;
  let stopped: NodeJS.Signals | undefined;
  const stop = (signal: NodeJS.Signals) => { stopped = signal; child?.kill(signal); };
  const interrupt = () => stop("SIGINT"), terminate = () => stop("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    return await executeAppJourneyPlan(plan, async step => {
      if (stopped) return 128 + constants.signals[stopped];
      console.log(`\n${step.name}`);
      return new Promise<number>((resolveCode, reject) => {
        child = spawn(process.execPath, [cli, ...step.args], {
          cwd: root, stdio: "inherit", env: { ...process.env, ...step.environment },
        });
        child.once("error", () => reject(new Error("Unable to start the browser test process.")));
        child.once("close", (code, signal) => {
          child = undefined;
          resolveCode(stopped ? 128 + constants.signals[stopped] : code ?? (signal ? 128 + constants.signals[signal] : 1));
        });
      });
    });
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(error instanceof Error ? error.message : "App journey runner failed.");
    process.exitCode = 1;
  });
}
