import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One browser per fresh provider fixture set: repeated provider IDs are guarded.
process.env.QA_FIXTURE_INFO ??= join(tmpdir(), `marketing-social-browser-${process.pid}.json`);
const requested = process.argv.filter(argument => argument.startsWith("--project="));
if (requested.length > 1) throw new Error("Run each social-delivery browser against a fresh fixture set.");
process.env.QA_DELIVERY_BROWSER ??= requested[0]?.slice("--project=".length) ?? "chromium";
const deliveryBrowser = process.env.QA_DELIVERY_BROWSER;
if (!["chromium", "firefox", "webkit"].includes(deliveryBrowser)) throw new Error("Choose one supported delivery browser.");
const baseURL = process.env.BASE_URL ?? "http://127.0.0.1:3156";
export default defineConfig({
  testDir: "./tests/e2e", testMatch: "social-all-destinations.spec.ts", fullyParallel: false,
  forbidOnly: Boolean(process.env.CI), retries: 0, workers: 1, timeout: 180_000,
  expect: { timeout: 30_000 }, outputDir: "test-results/social-delivery",
  reporter: [["line"], ["html", { open: "never", outputFolder: "social-delivery-report" }],
    ["junit", { outputFile: "test-results/social-delivery/junit.xml" }]],
  use: { baseURL, actionTimeout: 20_000, navigationTimeout: 30_000,
    trace: "retain-on-failure", screenshot: "only-on-failure", video: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ].filter(project => project.name === deliveryBrowser),
  webServer: { command: "npm run test:e2e:delivery-app", url: baseURL,
    reuseExistingServer: false, timeout: 180_000 },
});
