import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FunnelBrowserFixtureInfo } from "../support/start-funnel-app";

async function customer(info: TestInfo) {
  const fixture: FunnelBrowserFixtureInfo = JSON.parse(await readFile(process.env.QA_FUNNEL_FIXTURE_INFO!, "utf8"));
  return fixture.customers[`tracking-${info.project.name}`];
}
async function signIn(page: Page, info: TestInfo, returnTo = "/tracking") {
  const account = await customer(info);
  await page.goto(`/sign-in?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByLabel(/^Email/).fill(account.email);
  await page.getByLabel(/^Password/).fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${returnTo.replaceAll("/", "\\/")}(?:\\?.*)?$`));
  return account;
}
async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

test("source forms create and edit native tracking, show actual accepted receipts and remain usable by keyboard on narrow screens", async ({ page }, info) => {
  const exceptions: string[] = []; page.on("pageerror", error => exceptions.push(error.message));
  await signIn(page, info);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tracking sources");
  await page.getByRole("button", { name: "Connect source", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Create source", exact: true }).click();
  const errorSummary = page.getByRole("alert").filter({ hasText: "Check source setup" });
  await expect(errorSummary).toBeFocused();
  await expect(errorSummary.getByRole("link", { name: "Enter a source name." })).toBeVisible();
  const title = `Website enquiry intake ${randomUUID().slice(0, 8)}`;
  await page.getByLabel("Source name", { exact: true }).fill(title);
  await page.getByLabel("Stable source identity", { exact: true }).fill(`website-${randomUUID()}`);
  await page.getByLabel("Allowed website origins", { exact: true }).fill("https://forms.example.test");
  await page.getByRole("button", { name: "Create source", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Source saved", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Open source diagnostics", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
  const sourceId = new URL(page.url()).pathname.split("/").at(-1)!;
  await expect(page.getByText("No receipts yet", { exact: true })).toBeVisible();
  await page.getByText("Edit configuration and credentials", { exact: true }).click();
  const properties = page.getByLabel("Allowed property names", { exact: true });
  await properties.fill("path\ninterest");
  await page.getByRole("button", { name: "Save source settings", exact: true }).click();
  await expect(page.getByText(`Source ID: ${sourceId} · Generation 2`, { exact: true })).toBeVisible();
  const sourceResponse = await page.request.get(`/api/tracking/sources/${sourceId}?environment=TEST`);
  expect(sourceResponse.ok()).toBe(true); expect((await sourceResponse.json()).config.propertyKeys).toEqual(["path", "interest"]);
  const submission = await page.request.post(`/api/tracking/ingest/${sourceId}/form`, {
    headers: { Origin: "https://forms.example.test" }, data: { schemaVersion: 1, eventId: randomUUID(), name: "Source UI fixture", email: "form-fixture@example.test", properties: { interest: "Consultation" } },
  });
  expect(submission.status()).toBe(202); const receiptId = (await submission.json()).receipts[0].id;
  await page.getByRole("button", { name: "Refresh diagnostics", exact: true }).click();
  const receipt = page.locator(`#event-${receiptId}`);
  await expect(receipt).toContainText("Waiting for matching");
  await receipt.getByText("Inspect identity and evidence", { exact: true }).focus(); await page.keyboard.press("Enter");
  await expect(receipt).toContainText("Consultation"); await expect(receipt).not.toContainText("form-fixture@example.test");
  await expect(page.getByText("Events received; identity matching is not yet established.", { exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath("tracking-source-desktop.png"), fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await noHorizontalOverflow(page);
  await receipt.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("tracking-source-mobile.png"), fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 320, height: 740 });
  await noHorizontalOverflow(page);
  await page.getByText("Source availability", { exact: true }).scrollIntoViewIfNeeded();
  await page.getByRole("combobox", { name: "Availability", exact: true }).selectOption("PAUSED");
  await expect(page.getByRole("button", { name: "Save availability", exact: true })).toBeDisabled();
  await page.getByLabel("I understand the effect on queued evidence and waits.", { exact: true }).check();
  await page.getByRole("button", { name: "Save availability", exact: true }).click();
  await expect(page.getByText(`Source ID: ${sourceId} · Generation 3`, { exact: true })).toBeVisible();
  expect((await page.request.post(`/api/tracking/ingest/${sourceId}/form`, {
    headers: { Origin: "https://forms.example.test" }, data: { schemaVersion: 1, eventId: randomUUID(), email: "form-fixture@example.test", properties: {} },
  })).status()).toBe(404);
  expect(exceptions).toEqual([]);
});

test("API signing setup is shown once and environment switching cannot lose an unsaved credential", async ({ page }, info) => {
  await signIn(page, info);
  await page.getByRole("button", { name: "Connect source", exact: true }).click();
  await page.getByRole("combobox", { name: "Source type", exact: true }).selectOption("API");
  await page.getByLabel("Source name", { exact: true }).fill("Server events from private application");
  await page.getByLabel("Stable source identity", { exact: true }).fill(`server-${randomUUID()}`);
  await page.getByRole("button", { name: "Create source", exact: true }).click();
  const secretField = page.getByLabel("Server signing secret", { exact: true });
  await expect(secretField).toHaveAttribute("type", "password");
  const secret = await secretField.inputValue(); expect(secret.length).toBeGreaterThanOrEqual(16);
  await expect(page.getByRole("combobox", { name: "Environment", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Close source setup", exact: true })).toBeDisabled();
  await page.getByRole("navigation", { name: "Global navigation", exact: true }).getByRole("link", { name: "Funnels", exact: true }).click();
  await expect(page).toHaveURL(/\/tracking(?:\?|$)/);
  await expect(page.getByRole("status").filter({ hasText: "Complete the current source setup and save any one-time credentials before leaving." })).toBeVisible();
  await expect(secretField).toHaveValue(secret);
  await page.getByRole("button", { name: "I have saved it", exact: true }).click();
  await expect(secretField).toHaveCount(0);
  await page.getByRole("link", { name: "Open source diagnostics", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Server events from private application");
  const id = new URL(page.url()).pathname.split("/").at(-1)!;
  await page.reload(); await expect(page.getByRole("heading", { level: 1 })).toHaveText("Server events from private application");
  const detail = await page.request.get(`/api/tracking/sources/${id}`); expect(await detail.text()).not.toContain(secret);
  await page.getByText("Edit configuration and credentials", { exact: true }).click();
  await page.getByLabel("Replace saved credentials", { exact: true }).check();
  await expect(page.getByLabel("Signing secret", { exact: true })).toHaveValue("");
  expect((await page.request.get(`/api/tracking/sources/${id}?environment=LIVE`)).status()).toBe(404);
});

test("source inbox supports an audited manual match and history replay without creating a message", async ({ page }, info) => {
  const account = await signIn(page, info);
  const sources = await (await page.request.get("/api/tracking/sources?environment=TEST")).json();
  const source = sources.find((item: { name: string }) => item.name === "Unmatched website observation");
  expect(source, "fixture provides a real unmatched browser observation").toBeTruthy();
  const before = await (await page.request.get(`/api/tracking/sources/${source.id}/events?order=newest`)).json();
  const observation = before.events.find((event: { status: string }) => event.status === "UNMATCHED"); expect(observation).toBeTruthy();
  await page.goto(`/tracking/${source.id}?environment=TEST&event=${observation.id}`);
  const card = page.locator(`#event-${observation.id}`); await expect(card).toContainText("Needs identity review");
  await card.getByText("Match to an existing subject", { exact: true }).focus(); await page.keyboard.press("Enter");
  await card.getByLabel(/Owned subject ID/).fill(account.subjectIds[1]);
  await card.getByLabel("Why this match is correct", { exact: true }).fill("The customer's enquiry record confirmed this visit.");
  await card.getByRole("button", { name: "Queue audited match", exact: true }).click();
  await expect(card).toContainText("Waiting for matching"); await expect(card).toContainText("REPLAY");
  const after = await (await page.request.get(`/api/tracking/sources/${source.id}/events?eventId=${observation.id}`)).json();
  expect(after.events[0].subjectId).toBe(account.subjectIds[1]); expect(after.events[0].processingMode).toBe("REPLAY");
  const audit = await (await page.request.get(`/api/tracking/sources/${source.id}/audit`)).json();
  expect(audit.some((item: { action: string; reason: string }) => item.action === "MANUAL_MATCH" && item.reason.includes("confirmed this visit"))).toBe(true);
  await page.goto(`/tracking/${account.sourceId}?environment=TEST`);
  const matched = page.getByTestId("tracking-event").filter({ hasText: "Matched" }).first();
  await matched.getByText("History-only recovery", { exact: true }).focus(); await page.keyboard.press("Enter");
  await matched.getByRole("button", { name: "Queue history replay", exact: true }).click();
  await expect(page.getByText("History-only replay queued. Refresh after processing.", { exact: true })).toBeVisible();
  expect((await page.request.get(`/api/marketing-campaigns/${account.campaignId}/memberships`).then(r => r.json())).memberships).toEqual([]);
});

test("sign-in waits for its handlers before accepting input when the page script is delayed", async ({ page }, info) => {
  const account = await customer(info);
  let releaseScript!: () => void, markBlocked!: () => void;
  const scriptGate = new Promise<void>(resolve => { releaseScript = resolve; });
  const scriptBlocked = new Promise<void>(resolve => { markBlocked = resolve; });
  const loginBodies: unknown[] = [];
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/auth/login") loginBodies.push(request.postDataJSON());
  });
  await page.route("**/_next/static/chunks/app/sign-in/**", async route => {
    markBlocked(); await scriptGate; await route.continue();
  });
  const returnTo = `/tracking/${account.sourceId}`;
  try {
    await page.goto(`/sign-in?returnTo=${encodeURIComponent(returnTo)}`, { waitUntil: "commit" });
    await scriptBlocked;
    await expect(page.getByLabel(/^Email/)).toBeDisabled();
    await expect(page.getByLabel(/^Password/)).toBeDisabled();
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeDisabled();
    expect(loginBodies).toEqual([]);
  } finally { releaseScript(); }
  await expect(page.getByLabel(/^Email/)).toBeEnabled();
  await page.getByLabel(/^Email/).fill(account.email);
  await page.getByLabel(/^Password/).fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Fixture CRM");
  await expect(page).toHaveURL(new URL(returnTo, page.url()).href);
  expect(loginBodies).toEqual([{ email: account.email, password: account.password }]);
});

test("source deep links require authentication and hide another customer's source", async ({ page, browser }, info) => {
  const account = await customer(info);
  await page.goto(`/tracking/${account.sourceId}?environment=TEST`);
  await expect(page).toHaveURL(/\/sign-in\?returnTo=/);
  await page.getByLabel(/^Email/).fill(account.email);
  await page.getByLabel(/^Password/).fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Fixture CRM");
  const foreign = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const fixture: FunnelBrowserFixtureInfo = JSON.parse(await readFile(process.env.QA_FUNNEL_FIXTURE_INFO!, "utf8"));
    const another = fixture.customers[`funnels-${info.project.name}`];
    const login = await foreign.request.post("/api/auth/login", { headers: { Origin: new URL(page.url()).origin }, data: { email: another.email, password: another.password } });
    expect(login.ok()).toBe(true);
    const denied = await foreign.request.get(`/api/tracking/sources/${account.sourceId}?environment=TEST`);
    expect(denied.status()).toBe(404); expect(await denied.text()).not.toContain("Fixture CRM");
    expect((await foreign.request.get(`/api/tracking/sources/${account.sourceId}/events`)).status()).toBe(404);
  } finally { await foreign.close(); }
});
