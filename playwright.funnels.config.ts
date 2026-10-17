import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.QA_FUNNEL_FIXTURE_INFO ??= join(tmpdir(), `launchpad-funnel-browser-${process.pid}.json`);
process.env.QA_FUNNEL_PROVIDER_ORIGIN ??= "http://127.0.0.1:3168";
const baseURL = process.env.BASE_URL ?? "http://127.0.0.1:3167";
export default defineConfig({
  testDir: "./tests/e2e", testMatch: ["funnel-builder.spec.ts", "email-workspace.spec.ts", "tracking-workspace.spec.ts"], fullyParallel: false,
  forbidOnly: Boolean(process.env.CI), retries: 0, workers: 1, timeout: 180_000,
  expect: { timeout: 20_000 }, outputDir: "test-results/funnels",
  reporter: [["line"], ["html", { open: "never", outputFolder: "funnels-report" }], ["junit", { outputFile: "test-results/funnels/junit.xml" }]],
  use: { baseURL, actionTimeout: 15_000, navigationTimeout: 30_000,
    trace: process.env.QA_FUNNEL_TRACE === "1" ? "retain-on-failure" : "off", screenshot: "only-on-failure", video: "off" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: { command: "node --import tsx tests/support/start-funnel-app.ts", url: baseURL, reuseExistingServer: false, timeout: 240_000 },
});
