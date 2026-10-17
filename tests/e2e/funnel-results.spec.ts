import { test, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { FunnelBrowserFixtureInfo, FunnelBrowserReportCustomer } from "../support/start-funnel-app";
import type { FunnelReport } from "../../apps/web/src/server/funnels/funnelReportingTypes";

const exceptions = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = []; exceptions.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
});
test.afterEach(({ page }) => { expect(exceptions.get(page), "Results must not raise a browser exception").toEqual([]); });

async function signIn(page: Page, info: TestInfo): Promise<FunnelBrowserReportCustomer> {
  const fixture: FunnelBrowserFixtureInfo = JSON.parse(await readFile(process.env.QA_FUNNEL_FIXTURE_INFO!, "utf8"));
  const customer = fixture.reports[info.project.name];
  expect(JSON.stringify(customer)).not.toMatch(/apiKey|webhookUrl|signingSecret|Ciphertext|accessToken/);
  await page.goto("/sign-in?returnTo=%2Ffunnels");
  await page.getByLabel(/^Email/).fill(customer.email); await page.getByLabel(/^Password/).fill(customer.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click(); await expect(page).toHaveURL(/\/funnels$/);
  return customer;
}
async function stats(page: Page) {
  const response = await page.request.get(`${process.env.QA_FUNNEL_PROVIDER_ORIGIN}/__stats`); expect(response.status()).toBe(200); return response.json();
}
async function report(page: Page, id: string, versionId: string, from: string, to: string): Promise<FunnelReport> {
  const response = await page.request.get(`/api/funnels/${id}/reports?${new URLSearchParams({ versionId, from, to })}`);
  expect(response.status()).toBe(200); const result = await response.json();
  expect(JSON.stringify(result)).not.toMatch(/maya@example|buyer@example|signingSecret|Ciphertext/);
  return result;
}
async function state(page: Page, id: string) {
  const [funnel, journeys] = await Promise.all([page.request.get(`/api/funnels/${id}`), page.request.get(`/api/funnels/${id}/journeys`)]);
  expect(funnel.status()).toBe(200); expect(journeys.status()).toBe(200);
  return { funnel: await funnel.json(), journeys: await journeys.json() };
}
async function openResults(page: Page, id: string, versionId?: string) {
  await page.goto(`/funnels/${id}?view=results${versionId ? `&versionId=${encodeURIComponent(versionId)}` : ""}`);
  await expect(page.getByRole("heading", { name: "Funnel results", exact: true })).toBeVisible();
}
async function apply(page: Page, versionId: string, from: string, to: string) {
  await page.getByRole("combobox", { name: "Published version", exact: true }).selectOption(versionId);
  await page.getByLabel("Entered from (UTC)", { exact: true }).fill(from.slice(0, 16));
  await page.getByLabel("Entered before (UTC)", { exact: true }).fill(to.slice(0, 16));
  const response = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/reports") && response.request().method() === "GET");
  await page.getByRole("button", { name: "Apply filters", exact: true }).click(); expect((await response).status()).toBe(200);
}
async function view(page: Page, name: "Overview" | "Campaign results" | "Stage board") {
  await page.getByRole("button", { name, exact: true }).click();
}
async function noOverflow(page: Page) {
  const measure = () => page.evaluate(() => {
    const describe = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element), parent = element.parentElement?.getBoundingClientRect();
      return { tag: element.tagName, type: element instanceof HTMLInputElement ? element.type : undefined,
        classes: element.className.slice(0, 180), right: rect.right, left: rect.left, width: rect.width,
        clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, parentWidth: parent?.width,
        minWidth: style.minWidth, maxWidth: style.maxWidth, overflowX: style.overflowX, display: style.display,
        font: style.font, boxSizing: style.boxSizing };
    };
    return { viewport: innerWidth, content: document.documentElement.scrollWidth, locale: navigator.language,
      overflow: [...document.querySelectorAll<HTMLElement>("main *")].filter(element => {
        const rect = element.getBoundingClientRect(); return rect.height > 0 && (rect.right > innerWidth || rect.left < 0);
      }).slice(-35).map(describe),
      filterControls: [...document.querySelectorAll<HTMLElement>('form[aria-label="Result filters"] input, form[aria-label="Result filters"] select')].map(describe) };
  });
  const widths = await measure();
  expect(widths.content, JSON.stringify(widths)).toBeLessThanOrEqual(widths.viewport);
  // Native date controls vary by OS. Exercise modest text enlargement to expose intrinsic grid sizing locally too.
  const enlargedText = await page.addStyleTag({ content: 'form[aria-label="Result filters"] input, form[aria-label="Result filters"] select { font-size: 20px; }' });
  try {
    const enlarged = await measure();
    expect(enlarged.content, `Enlarged filter text: ${JSON.stringify(enlarged)}`).toBeLessThanOrEqual(enlarged.viewport);
    const from = page.getByLabel("Entered from (UTC)", { exact: true }), value = await from.inputValue();
    await from.focus(); await expect(from).toBeFocused(); await from.press("ArrowRight");
    await expect(from).toBeFocused(); await expect(from).toHaveValue(value);
  } finally { await enlargedText.evaluate(element => { element.parentNode?.removeChild(element); }); }
}
function metric(scope: Page | Locator, label: string) {
  return scope.getByText(label, { exact: true }).locator("..").locator("dd").first();
}

test("results preserve version and UTC cohort while separating enquiry cycles, goals and configured campaigns", async ({ page }, info) => {
  const customer = await signIn(page, info), beforeStats = await stats(page), before = await state(page, customer.salesFunnelId);
  const full = await report(page, customer.salesFunnelId, customer.salesVersion1Id, customer.fromInclusive, customer.allTo);
  expect(full.totals).toMatchObject({ journeys: 4, distinctSubjects: 3, repeatCycles: 1, active: 3, succeeded: 1, goalJourneys: 2 });
  const cohort = await report(page, customer.salesFunnelId, customer.salesVersion1Id, customer.fromInclusive, customer.toExclusive);
  expect(cohort.totals).toMatchObject({ journeys: 3, distinctSubjects: 2, repeatCycles: 1, active: 2, succeeded: 1, goalJourneys: 2 });
  expect(cohort.totals.goalRate).toMatchObject({ numerator: 2, denominator: 3 });
  expect(cohort.stages.map(stage => [stage.name, stage.everReachedJourneys, stage.currentJourneys])).toEqual([
    ["Lead", 3, 1], ["Discovery booked", 2, 1], ["Client onboarded", 1, 1],
  ]);
  expect(cohort.attribution).toMatchObject({ taggedSubjects: 1, unknownSubjects: 1, partialSubjects: 1, revenueCredit: "NONE" });
  expect(cohort.campaigns).toMatchObject({ uniqueMemberships: 0, uniqueAttributedSends: 0, results: [] });
  expect(cohort.campaigns.configuredLinks).toHaveLength(1);
  expect(cohort.money.currencies).toEqual([]); expect(cohort.money.pipelineValue.available).toBe(false);

  await openResults(page, customer.salesFunnelId);
  await expect(page.getByRole("combobox", { name: "Published version", exact: true })).toHaveValue(customer.salesVersion2Id);
  await expect(page.getByRole("region", { name: "Stage: New enquiry", exact: true })).toBeVisible();
  await expect(metric(page.locator('dl[aria-label="Journey totals"]'), "Journey cycles")).toHaveText("1");
  await apply(page, customer.salesVersion1Id, customer.fromInclusive, customer.toExclusive);
  const totals = page.locator('dl[aria-label="Journey totals"]');
  await expect(metric(totals, "Journey cycles")).toHaveText("3"); await expect(metric(totals, "Distinct subjects")).toHaveText("2");
  await expect(metric(totals, "Reached any goal")).toContainText("(2 / 3)"); await expect(metric(totals, "Active / pending")).toHaveText("2");
  for (const [name, reached, current] of [["Lead", "3", "1"], ["Discovery booked", "2", "1"], ["Client onboarded", "1", "1"]]) {
    const stage = page.getByRole("region", { name: `Stage: ${name}`, exact: true });
    await expect(metric(stage, "Ever reached")).toHaveText(reached); await expect(metric(stage, "Current journeys")).toHaveText(current);
  }
  await expect(page.getByRole("region", { name: "Stage: New enquiry", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Financial outcomes", exact: true })).toContainText("Pipeline value: unavailable.");
  await expect(page.getByText("No valued financial evidence with a supported currency in this window.", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("results-overview-desktop.png"), fullPage: true, animations: "disabled" });
  await view(page, "Campaign results");
  await expect(page.getByText("Consultation follow-up", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Campaign execution", exact: true })).toContainText("0 unique memberships · 0 unique attributed sends");
  const attribution = page.getByRole("region", { name: "Observed campaign references", exact: true });
  await expect(metric(attribution, "Tagged subjects")).toHaveText("1"); await expect(metric(attribution, "Unknown attribution")).toHaveText("1");
  await expect(metric(attribution, "Partial attribution")).toHaveText("1");
  await expect(page.getByRole("combobox", { name: "Published version", exact: true })).toHaveValue(customer.salesVersion1Id);
  await expect(page.getByLabel("Entered before (UTC)", { exact: true })).toHaveValue(customer.toExclusive.slice(0, 16));
  await view(page, "Stage board");
  const board = page.getByRole("region", { name: "Stage board", exact: true });
  await expect(board.getByRole("status")).toContainText("Loaded 3 of 3 matching journeys");
  await expect(board.getByText("maya@example.test", { exact: true })).toHaveCount(3);
  await expect(board.getByText(`Subject ${customer.salesSubjectIds[0]} · Cycle 1`, { exact: true })).toBeVisible();
  await expect(board.getByText(`Subject ${customer.salesSubjectIds[0]} · Cycle 2`, { exact: true })).toBeVisible();
  await expect(board.getByText(`Subject ${customer.salesSubjectIds[1]} · Cycle 1`, { exact: true })).toBeVisible();
  await expect(board.getByRole("region", { name: "Board stage: Lead", exact: true })).toContainText("1 current in report");
  for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width: 320, height: 740 }); await page.getByRole("combobox", { name: "Appearance", exact: true }).selectOption(theme);
    await noOverflow(page); const refresh = board.getByRole("button", { name: "Refresh board", exact: true });
    await refresh.focus(); await expect(refresh).toBeFocused(); expect((await refresh.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: info.outputPath(`results-board-320-${theme}.png`), fullPage: true, animations: "disabled" });
  }
  const historyLink = board.getByRole("link", { name: "Inspect journey 2", exact: true });
  await historyLink.click(); await expect(page).toHaveURL(/\/journeys\/[^/?]+$/);
  await expect(page.getByRole("region", { name: "Journey history", exact: true })).toContainText(customer.salesSubjectIds[0]);
  await openResults(page, customer.salesFunnelId, customer.salesVersion1Id);
  await expect(page.getByRole("combobox", { name: "Published version", exact: true })).toHaveValue(customer.salesVersion1Id);
  expect(await state(page, customer.salesFunnelId)).toEqual(before); expect(await stats(page)).toEqual(beforeStats);
});

test("purchase results display exact independent currencies and refund evidence without sending email", async ({ page }, info) => {
  const customer = await signIn(page, info), beforeStats = await stats(page), before = await state(page, customer.purchaseFunnelId);
  const result = await report(page, customer.purchaseFunnelId, customer.purchaseVersionId, customer.fromInclusive, customer.allTo);
  expect(result.totals).toMatchObject({ journeys: 3, distinctSubjects: 3, goalJourneys: 3 });
  expect(result.money.currencies.map(currency => ({ currency: currency.currency, paid: currency.grossPaid.amount, refunded: currency.successfulRefunds.amount, net: currency.netObservedCash }))).toEqual([
    { currency: "GBP", paid: "0.3", refunded: "0.1", net: "0.2" }, { currency: "USD", paid: "1.234567", refunded: "0", net: "1.234567" },
  ]);
  expect(result.money).toMatchObject({ includedFacts: 4, valuedFacts: 4, unvaluedFacts: 0, authorityCounts: { PROVIDER_VERIFIED: 4 } });
  await openResults(page, customer.purchaseFunnelId);
  await apply(page, customer.purchaseVersionId, customer.fromInclusive, customer.allTo);
  const gbp = page.getByRole("region", { name: "Money: GBP", exact: true }), usd = page.getByRole("region", { name: "Money: USD", exact: true });
  await expect(metric(gbp, "Gross paid").getByText("0.3", { exact: true })).toBeVisible();
  await expect(metric(gbp, "Successful refunds").getByText("0.1", { exact: true })).toBeVisible();
  await expect(metric(gbp, "Observed net cash")).toHaveText("0.2");
  await expect(metric(usd, "Gross paid").getByText("1.234567", { exact: true })).toBeVisible();
  await expect(metric(usd, "Observed net cash")).toHaveText("1.234567");
  await expect(metric(usd, "Successful refunds")).toContainText("Not valued");
  await expect(metric(gbp, "Recorded won-deal value")).toContainText("Not valued");
  for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width: 320, height: 740 }); await page.getByRole("combobox", { name: "Appearance", exact: true }).selectOption(theme);
    await noOverflow(page); await page.screenshot({ path: info.outputPath(`results-money-320-${theme}.png`), fullPage: true, animations: "disabled" });
  }
  await apply(page, customer.purchaseVersionId, customer.fromInclusive, customer.toExclusive);
  await expect(page.getByText(/^No journeys entered this version in the selected window\./)).toBeVisible();
  await expect(page.getByRole("region", { name: "Money: GBP", exact: true })).toHaveCount(0);
  expect(await state(page, customer.purchaseFunnelId)).toEqual(before); expect(await stats(page)).toEqual(beforeStats);
});

test("stage board pages real journeys without changing full report counts and resets cards when filters change", async ({ page }, info) => {
  const customer = await signIn(page, info), beforeStats = await stats(page);
  const result = await report(page, customer.boardFunnelId, customer.boardVersionId, customer.fromInclusive, customer.allTo);
  expect(result.totals.journeys).toBe(51); expect(result.stages[0].currentJourneys).toBe(51);
  await openResults(page, customer.boardFunnelId); await view(page, "Stage board");
  const board = page.getByRole("region", { name: "Stage board", exact: true });
  await expect(board.getByRole("status")).toContainText("Loaded 50 of 51 matching journeys");
  await expect(board.getByRole("listitem")).toHaveCount(50); await expect(board).toContainText("51 current in report");
  await board.getByRole("button", { name: "Load more board journeys", exact: true }).click();
  await expect(board.getByRole("status")).toContainText("Loaded 51 of 51 matching journeys");
  await expect(board.getByRole("listitem")).toHaveCount(51);
  const subjects = await board.getByText(/^Subject .+ · Cycle 1$/).allTextContents(); expect(new Set(subjects).size).toBe(51);
  await expect(board.getByRole("button", { name: "Load more board journeys", exact: true })).toHaveCount(0);
  await apply(page, customer.boardVersionId, customer.fromInclusive, customer.toExclusive);
  await expect(board.getByText("No journeys match this version and entry window.", { exact: true })).toBeVisible();
  await expect(board.getByRole("listitem")).toHaveCount(0);
  expect(await stats(page)).toEqual(beforeStats);
});
