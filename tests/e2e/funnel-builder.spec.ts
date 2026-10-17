import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { FunnelBrowserFixtureInfo, FunnelBrowserCustomer } from "../support/start-funnel-app";
import type { FunnelDefinition } from "../../apps/web/src/server/funnels/funnelDefinition";

const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page, context }) => {
  const errors: string[] = []; pageErrors.set(page, errors);
  const record = (error: Error) => { errors.push(error.message); console.error("Funnel browser exception:", error.message); };
  page.on("pageerror", record); context.on("page", next => next.on("pageerror", record));
});
test.afterEach(async ({ page }) => { expect(pageErrors.get(page) ?? [], "The funnel workspace must not raise a client exception").toEqual([]); });

async function signIn(page: Page, info: TestInfo): Promise<FunnelBrowserCustomer> {
  expect(process.env.QA_FUNNEL_FIXTURE_INFO).toBeTruthy();
  const fixture: FunnelBrowserFixtureInfo = JSON.parse(await readFile(process.env.QA_FUNNEL_FIXTURE_INFO!, "utf8"));
  expect(JSON.stringify(fixture)).not.toMatch(/apiKey|webhookUrl|signingSecret|Ciphertext|accessToken/);
  const customer = fixture.customers[`funnels-${info.project.name}`];
  await page.goto("/sign-in?returnTo=%2Ffunnels");
  await page.getByLabel(/^Email/).fill(customer.email);
  await page.getByLabel(/^Password/).fill(customer.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/funnels$/);
  return customer;
}
async function readFunnel(page: Page, id: string) {
  const response = await page.request.get(`/api/funnels/${id}`); expect(response.status()).toBe(200);
  return response.json() as Promise<{ id: string; name: string; subjectKind: string; draftRevision: number; draft: FunnelDefinition;
    publishedVersionId: string | null; automationEnrolmentEnabled: boolean; automationDispatchEnabled: boolean }>;
}
async function providerStats(page: Page) {
  const response = await page.request.get(`${process.env.QA_FUNNEL_PROVIDER_ORIGIN}/__stats`);
  expect(response.status()).toBe(200); return response.json();
}
async function noHorizontalOverflow(page: Page) {
  const width = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth,
    overflowing: [...document.querySelectorAll<HTMLElement>("main *")].map(element => ({ tag: element.tagName, text: element.textContent?.trim().slice(0, 60),
      right: Math.round(element.getBoundingClientRect().right), height: element.getBoundingClientRect().height })).filter(element => element.height > 0 && element.right > innerWidth + 1).slice(-15) }));
  expect(width.document, JSON.stringify(width)).toBeLessThanOrEqual(width.viewport);
}
async function addStage(page: Page, name: string) {
  await page.getByRole("button", { name: "Add next stage", exact: true }).click();
  const form = page.getByRole("group", { name: "New custom stage", exact: true });
  await form.getByLabel("Stage name", { exact: true }).fill(name);
  await form.getByRole("button", { name: "Add stage", exact: true }).click();
  await expect(page.getByRole("heading", { name: `${name} settings`, exact: true })).toBeFocused();
}
async function selectStage(page: Page, name: string) {
  const target = page.getByRole("navigation", { name: "Stage list", exact: true }).getByRole("button", { name: new RegExp(`^\\d+\\. ${name}`) });
  await target.focus(); await page.keyboard.press("Space");
  await expect(page.getByLabel("Stage name", { exact: true })).toHaveValue(name);
}
async function addRule(page: Page, sourceId: string, to: string, entry = false) {
  await page.getByRole("navigation", { name: "Stage settings sections", exact: true }).getByRole("button", { name: "Tracking", exact: true }).click();
  await page.getByRole("button", { name: "Add event rule", exact: true }).click();
  const form = page.getByRole("group", { name: "New event rule", exact: true });
  await form.getByRole("combobox", { name: "Rule starts", exact: true }).selectOption(entry ? "ENTRY" : "STAGE");
  await form.getByRole("combobox", { name: "Data source", exact: true }).selectOption(sourceId);
  await form.getByRole("combobox", { name: "Event", exact: true }).selectOption("enquiry.accepted");
  await form.getByRole("combobox", { name: "Go to stage", exact: true }).selectOption({ label: to });
  await form.getByRole("button", { name: "Add rule", exact: true }).click();
}

test("subscription activation source and template require only the signed activation event", async ({ page }, info) => {
  await signIn(page, info);
  const before = await providerStats(page);
  await page.goto("/tracking?environment=TEST");
  await page.getByRole("button", { name: "Connect source", exact: true }).click();
  await page.getByRole("combobox", { name: "Source type", exact: true }).selectOption("API");
  await page.getByLabel("Source name", { exact: true }).fill("Fluxsoft subscription activations");
  await page.getByLabel("Stable source identity", { exact: true }).fill(`fluxsoft-${info.project.name}`);
  const accepted = page.getByRole("group", { name: "Accepted event types", exact: true });
  for (const checkbox of await accepted.getByRole("checkbox").all()) await checkbox.uncheck();
  await page.getByRole("textbox", { name: /^Additional custom event names/ }).fill("custom.fluxsoft.subscription_active");
  await page.getByLabel("Allowed property names", { exact: true }).fill("");
  await page.getByRole("button", { name: "Create source", exact: true }).click();
  await expect(page.getByLabel("Server signing secret", { exact: true })).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "I have saved it", exact: true }).click();
  await page.getByRole("link", { name: "Open source diagnostics", exact: true }).click();
  await expect(page).toHaveURL(/\/tracking\/[^/?]+\?environment=TEST$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Fluxsoft subscription activations");
  const sourceId = new URL(page.url()).pathname.split("/").at(-1)!;
  await page.getByText("Installation instructions", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Subscription activation events", exact: true })).toBeVisible();
  await expect(page.getByText(/the Fluxsoft activation bridge supplies no recipient or marketing consent/)).toBeVisible();
  const example = page.locator("pre").filter({ hasText: "STABLE_SUBSCRIPTION_ID" });
  await expect(example).toBeVisible();
  expect(JSON.parse(await example.innerText())).toMatchObject({
    type: "custom.fluxsoft.subscription_active", subjectKind: "SUBSCRIPTION", resource: { kind: "SUBSCRIPTION" }, properties: {},
  });
  expect(await example.innerText()).not.toMatch(/contactIdentity|invoice|amount|trial/);
  await page.setViewportSize({ width: 320, height: 740 });
  await noHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath("subscription-source-320.png"), fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.goto("/funnels/create?environment=TEST");
  await page.getByLabel("Funnel name", { exact: true }).fill("Fluxsoft activation tracking");
  const template = page.getByRole("combobox", { name: "Starting template", exact: true });
  const subject = page.getByRole("combobox", { name: "Count a journey for", exact: true });
  await template.selectOption("subscription");
  await expect(subject).toHaveValue("SUBSCRIPTION");
  await expect(page.getByText(/The Fluxsoft activation bridge does not supply those trial events/)).toBeVisible();
  await subject.selectOption("CONTACT");
  await template.selectOption("subscription-activation");
  await expect(subject).toHaveValue("SUBSCRIPTION");
  const source = page.getByRole("combobox", { name: "Primary data source", exact: true });
  await expect(source.locator("option")).toHaveCount(2);
  await source.selectOption(sourceId);
  await page.setViewportSize({ width: 320, height: 740 });
  await noHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath("subscription-activation-template-320.png"), fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "Create draft", exact: true }).click();
  await expect(page).toHaveURL(/\/funnels\/[^/?]+$/);
  const funnelId = new URL(page.url()).pathname.split("/").at(-1)!;
  const draft = await readFunnel(page, funnelId);
  expect(draft.subjectKind).toBe("SUBSCRIPTION");
  expect(draft.draft.stages).toEqual([{ id: "active", name: "Subscription active", goal: true, terminal: "NONE" }]);
  expect(draft.draft.routes).toHaveLength(1);
  expect(draft.draft.routes[0].trigger).toEqual({ kind: "EVENT", sourceId, type: "custom.fluxsoft.subscription_active" });
  expect(draft.draft.stageActions ?? []).toEqual([]);
  await page.getByRole("button", { name: "Review & publish", exact: true }).click();
  await page.getByRole("button", { name: "Publish reviewed revision", exact: true }).click();
  await expect(page.getByText("Published for future events. Existing journeys retain their original version.", { exact: true })).toBeVisible();
  const published = await readFunnel(page, funnelId);
  expect(published.automationEnrolmentEnabled).toBe(false); expect(published.automationDispatchEnabled).toBe(false);
  const views = page.getByRole("navigation", { name: "Funnel views", exact: true });
  await views.getByRole("button", { name: "Test journey", exact: true }).click();
  const simulator = page.getByRole("region", { name: "Test journey", exact: true });
  await simulator.getByRole("button", { name: "Add sample event", exact: true }).click();
  await simulator.getByRole("combobox", { name: "Sample source", exact: true }).selectOption(sourceId);
  await simulator.getByRole("button", { name: "Run no-send simulation", exact: true }).click();
  await expect(simulator.getByRole("heading", { name: "Simulated result: Subscription active", exact: true })).toBeVisible();
  expect((await (await page.request.get(`/api/funnels/${funnelId}/journeys`)).json()).journeys).toEqual([]);
  await views.getByRole("button", { name: "People / journeys", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Subscription journeys", exact: true })).toBeVisible();
  await views.getByRole("button", { name: "Results", exact: true }).click();
  await page.getByRole("navigation", { name: "Result views", exact: true }).getByRole("button", { name: "Stage board", exact: true }).click();
  await expect(page.getByRole("region", { name: "Stage board", exact: true })).toContainText("Independent subscriptions and their cycles.");
  await page.goto("/funnels");
  await expect(page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Fluxsoft activation tracking", exact: true }) })).toContainText("Subscriptions");
  expect(await providerStats(page)).toEqual(before);
});

test("custom funnel forms keep branch order, retain conflicting edits, publish tracking only and simulate without effects", async ({ page, context }, info) => {
  const customer = await signIn(page, info), before = await providerStats(page);
  await page.getByRole("link", { name: "Create funnel", exact: true }).click();
  await page.getByLabel("Funnel name", { exact: true }).fill("A consultation journey built from scratch");
  await page.getByRole("combobox", { name: "Starting template", exact: true }).selectOption("blank");
  await page.getByRole("button", { name: "Create draft", exact: true }).click();
  await expect(page).toHaveURL(/\/funnels\/[^/?]+$/);
  const funnelId = new URL(page.url()).pathname.split("/").at(-1)!;
  await page.getByLabel("Stage name", { exact: true }).fill("Inquiry received");
  await addStage(page, "Discovery call");
  await addStage(page, "Proposal approved");
  await page.getByLabel(/^Count reaching this stage as a goal/).check();
  await page.getByRole("combobox", { name: "Journey exit", exact: true }).selectOption("SUCCESS");
  const keyboardNode = page.getByTestId("funnel-canvas").locator(".react-flow__node").filter({ hasText: "Discovery call" });
  await expect(keyboardNode).toBeVisible();
  await keyboardNode.focus(); await expect(keyboardNode).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Stage name", { exact: true })).toHaveValue("Discovery call");
  await selectStage(page, "Inquiry received");
  await addRule(page, customer.sourceId, "Inquiry received", true);
  await addRule(page, customer.sourceId, "Proposal approved");
  const route = page.getByRole("group", { name: "Rule 2 · Leave this stage", exact: true });
  await route.getByRole("button", { name: "Add ordered branch", exact: true }).click();
  const firstBranch = route.getByRole("group", { name: "Branch 1", exact: true });
  await firstBranch.getByRole("combobox", { name: "Go to stage", exact: true }).selectOption({ label: "Proposal approved" });
  await route.getByRole("combobox", { name: "If no branch matches", exact: true }).selectOption("WAIT");
  await firstBranch.getByRole("button", { name: "Add condition", exact: true }).click();
  await firstBranch.getByRole("combobox", { name: "Field", exact: true }).selectOption("score");
  await firstBranch.getByRole("combobox", { name: "Value type", exact: true }).selectOption("number");
  await firstBranch.getByRole("combobox", { name: "Comparison", exact: true }).selectOption("gte");
  await firstBranch.getByLabel("Compare with", { exact: true }).fill("unfinished");
  await expect(page.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
  await page.getByRole("navigation", { name: "Stage list", exact: true }).getByRole("button", { name: /^2\. Discovery call/ }).click();
  await expect(page.getByLabel("Stage name", { exact: true })).toHaveValue("Inquiry received");
  await expect(firstBranch.getByLabel("Compare with", { exact: true })).toHaveValue("unfinished");
  await page.getByRole("navigation", { name: "Stage settings sections", exact: true }).getByRole("button", { name: "Campaigns", exact: true }).click();
  await expect(page.getByText("Complete or remove the invalid field before changing sections. Your unfinished value is preserved.", { exact: true })).toBeVisible();
  await expect(firstBranch.getByLabel("Compare with", { exact: true })).toHaveValue("unfinished");
  await firstBranch.getByLabel("Compare with", { exact: true }).fill("70");
  await firstBranch.getByRole("button", { name: "Group with more conditions", exact: true }).click();
  await firstBranch.getByRole("combobox", { name: "Match", exact: true }).selectOption("any");
  await firstBranch.getByRole("combobox", { name: "Match", exact: true }).selectOption("all");
  await firstBranch.getByRole("button", { name: "Add condition", exact: true }).click();
  await firstBranch.getByRole("combobox", { name: "Field", exact: true }).nth(1).selectOption("interest");
  await firstBranch.getByRole("combobox", { name: "Comparison", exact: true }).nth(1).selectOption("eq");
  await firstBranch.getByLabel("Compare with", { exact: true }).nth(1).fill("consulting");
  await route.getByRole("button", { name: "Add ordered branch", exact: true }).click();
  await route.getByRole("group", { name: "Branch 2", exact: true }).getByRole("combobox", { name: "Go to stage", exact: true }).selectOption({ label: "Discovery call" });
  await route.getByRole("button", { name: "Move branch 2 of rule 2 earlier", exact: true }).click();
  await route.getByRole("button", { name: "Move branch 1 of rule 2 later", exact: true }).click();
  await page.getByRole("navigation", { name: "Stage settings sections", exact: true }).getByRole("button", { name: "Campaigns", exact: true }).click();
  await page.getByRole("combobox", { name: "Connect another campaign", exact: true }).selectOption(customer.campaignId);
  await page.getByRole("button", { name: "Connect for attribution", exact: true }).click();
  await expect(page.getByText("Tracking only. No entry actions are configured.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText(/Draft revision 2 saved\. Published journeys are unchanged\./)).toBeVisible();
  const saved = await readFunnel(page, funnelId), initial = saved.draft.stages[0].id, goal = saved.draft.stages[2].id;
  expect(saved.draft.routes[1].branches.map(branch => branch.to)).toEqual([goal, saved.draft.stages[1].id]);
  expect(saved.draft.routes[1].branches[0].when).toEqual({ all: [
    { field: { scope: "EVENT", key: "score" }, type: "number", op: "gte", value: 70 },
    { field: { scope: "EVENT", key: "interest" }, type: "string", op: "eq", value: "consulting" },
  ] });
  expect(saved.draft.campaignLinks).toHaveLength(1); expect(saved.draft.stageActions ?? []).toHaveLength(0);
  await page.reload(); await expect(page.getByLabel("Stage name", { exact: true })).toHaveValue("Inquiry received");

  // Both tabs write through the production HTTP endpoint with real optimistic revision checks.
  const secondTab = await context.newPage();
  await secondTab.goto(`/funnels/${funnelId}`);
  await secondTab.getByText("Funnel details", { exact: true }).click();
  await secondTab.getByLabel("Funnel name", { exact: true }).fill("Server-reviewed consultation funnel");
  await secondTab.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(secondTab.getByText(/Draft revision 3 saved\. Published journeys are unchanged\./)).toBeVisible();
  await page.getByLabel("Stage name", { exact: true }).fill("Inquiry retained locally");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByRole("heading", { name: "A newer draft is saved", exact: true })).toBeVisible();
  await expect(page.getByLabel("Stage name", { exact: true })).toHaveValue("Inquiry retained locally");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download my local draft", exact: true }).click();
  const localDraft = JSON.parse(await readFile((await (await download).path())!, "utf8"));
  expect(localDraft.definition.stages[0].name).toBe("Inquiry retained locally");
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Reload server draft and discard local edits", exact: true }).click();
  await expect(page.getByLabel("Funnel name", { exact: true })).toHaveValue("Server-reviewed consultation funnel");
  await expect(page.getByLabel("Stage name", { exact: true })).toHaveValue("Inquiry received");
  await secondTab.getByLabel("Funnel name", { exact: true }).fill("Publication-reviewed consultation funnel");
  await secondTab.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(secondTab.getByText(/Draft revision 4 saved\. Published journeys are unchanged\./)).toBeVisible();
  await page.getByRole("button", { name: "Review & publish", exact: true }).click();
  await expect(page.getByRole("heading", { name: "A newer draft is saved", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Publication review", exact: true })).toHaveCount(0);
  expect((await readFunnel(page, funnelId)).publishedVersionId).toBeNull();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Reload server draft and discard local edits", exact: true }).click();
  await expect(page.getByLabel("Funnel name", { exact: true })).toHaveValue("Publication-reviewed consultation funnel");
  await secondTab.close();

  await page.getByRole("button", { name: "Review & publish", exact: true }).click();
  await expect(page.getByRole("region", { name: "Publication review", exact: true })).toContainText("0 explicit actions · 1 attribution-only campaign links");
  await page.getByRole("button", { name: "Publish reviewed revision", exact: true }).click();
  await expect(page.getByText("Published for future events. Existing journeys retain their original version.", { exact: true })).toBeVisible();
  const published = await readFunnel(page, funnelId);
  expect(published.publishedVersionId).toBeTruthy(); expect(published.automationEnrolmentEnabled).toBe(false); expect(published.automationDispatchEnabled).toBe(false);
  await page.getByRole("navigation", { name: "Funnel views", exact: true }).getByRole("button", { name: "Test journey", exact: true }).click();
  const simulator = page.getByRole("region", { name: "Test journey", exact: true });
  await simulator.getByRole("combobox", { name: "Start at", exact: true }).selectOption(initial);
  await simulator.getByRole("button", { name: "Add sample event", exact: true }).click();
  await simulator.getByRole("combobox", { name: "Sample source", exact: true }).selectOption(customer.sourceId);
  await simulator.getByRole("combobox", { name: "Sample event", exact: true }).selectOption("enquiry.accepted");
  await simulator.getByRole("button", { name: "Run no-send simulation", exact: true }).click();
  await expect(simulator.getByRole("heading", { name: "Simulated result: Inquiry received", exact: true })).toBeVisible();
  await expect(simulator.getByText(/UNKNOWN/).first()).toBeVisible();
  for (const [key, type, value] of [["score", "number", "80"], ["interest", "string", "consulting"]]) {
    await simulator.getByRole("button", { name: "Add sample property", exact: true }).click();
    await simulator.getByLabel("Property key", { exact: true }).last().fill(key);
    await simulator.getByRole("combobox", { name: "Value type", exact: true }).last().selectOption(type);
    await simulator.getByLabel("Sample value", { exact: true }).last().fill(value);
  }
  await simulator.getByRole("button", { name: "Run no-send simulation", exact: true }).click();
  await expect(simulator.getByRole("heading", { name: "Simulated result: Proposal approved", exact: true })).toBeVisible();
  expect(await providerStats(page)).toEqual(before);
  expect((await (await page.request.get(`/api/funnels/${funnelId}/journeys`)).json()).journeys).toEqual([]);
  expect(await readFunnel(page, funnelId)).toEqual(published);

  await page.getByRole("navigation", { name: "Funnel views", exact: true }).getByRole("button", { name: "Build", exact: true }).click();
  await expect(page.getByTestId("funnel-canvas")).toBeVisible();
  await page.screenshot({ path: info.outputPath("funnel-desktop.png"), fullPage: true, animations: "disabled" });
  await selectStage(page, "Proposal approved");
  await page.setViewportSize({ width: 320, height: 740 });
  await expect.poll(() => page.getByTestId("funnel-canvas").evaluate(canvas => {
    const viewport = canvas.getBoundingClientRect();
    return [...canvas.querySelectorAll(".react-flow__node")].every(node => {
      const bounds = node.getBoundingClientRect();
      return bounds.width > 0 && bounds.left >= viewport.left && bounds.right <= viewport.right && bounds.top >= viewport.top && bounds.bottom <= viewport.bottom;
    });
  }), { message: "Resize should fit every stage inside the mobile canvas" }).toBe(true);
  for (const theme of ["workspace"]) {
    await noHorizontalOverflow(page);
    const control = page.getByRole("button", { name: "Add next stage", exact: true });
    await control.focus(); await expect(control).toBeFocused();
    expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: info.outputPath(`funnel-320-${theme}.png`), fullPage: true, animations: "disabled" });
  }
  for (const summary of ["More", "Funnel details"]) {
    await page.getByText(summary, { exact: true }).click();
    await noHorizontalOverflow(page);
    await page.getByText(summary, { exact: true }).click();
  }
  await page.getByRole("button", { name: "Hide canvas", exact: true }).click();
  await expect(page.getByTestId("funnel-canvas")).toHaveCount(0);
  await selectStage(page, "Inquiry received");
  await page.getByRole("navigation", { name: "Stage settings sections", exact: true }).getByRole("button", { name: "Tracking", exact: true }).click();
  await expect(page.getByRole("region", { name: "Routing rules", exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
});

test("two enquiries retain separate pinned histories and manual correction affects only the selected journey", async ({ page }, info) => {
  const speculativeWorkspaceRequests: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (request.headers()["next-router-prefetch"] === "1" && /^(?:\/funnels(?:\/[^/]+)?|\/tracking|\/email)$/.test(path)) {
      speculativeWorkspaceRequests.push(path);
    }
  });
  const customer = await signIn(page, info), before = await providerStats(page);
  const savedFunnel = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Consultation journey", exact: true }) });
  await expect(savedFunnel).toBeVisible();
  for (const name of ["All funnels", "Tracking sources", "Email campaigns"]) {
    await page.getByRole("navigation", { name: "Funnel navigation", exact: true }).getByRole("link", { name, exact: true }).hover();
  }
  await page.getByRole("link", { name: "Create funnel", exact: true }).hover();
  await savedFunnel.getByRole("link", { name: "Consultation journey", exact: true }).hover();
  await savedFunnel.getByRole("link", { name: "Open funnel", exact: true }).hover();
  // Observe the complete list-to-editor lifecycle, including hover, without intercepting requests.
  await savedFunnel.getByRole("link", { name: "Open funnel", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/funnels/${customer.funnelId}$`));
  await expect(page.getByRole("navigation", { name: "Stage list", exact: true })).toBeVisible();
  expect(speculativeWorkspaceRequests, "Workspace links should load on navigation, without speculative RSC requests").toEqual([]);
  await page.goto(`/funnels/${customer.funnelId}?view=journeys`);
  await expect(page.getByRole("heading", { name: "People and business journeys", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "maya@example.test", exact: true })).toHaveCount(2);
  const card = page.getByRole("listitem").filter({ hasText: `Subject ${customer.subjectIds[0]} · cycle 1` });
  await card.getByRole("button", { name: "Inspect journey 1", exact: true }).click();
  const history = page.getByRole("region", { name: "Journey history", exact: true });
  await expect(history).toContainText(customer.subjectIds[0]); await expect(history).toContainText("Browser fixture: separately confirmed enquiry");
  await page.getByRole("combobox", { name: "Destination stage", exact: true }).selectOption("qualified");
  await page.getByLabel("Reason", { exact: true }).fill("Customer booked a discovery call by phone");
  await page.getByRole("button", { name: "Record tracking-only move", exact: true }).click();
  await expect(page.getByText("Manual move recorded with your reason. No new automation was started.", { exact: true })).toBeVisible();
  await expect(history).toContainText("Customer booked a discovery call by phone");
  await expect(history).toContainText("No automation actions were captured for this journey.");
  const journeysResponse = await page.request.get(`/api/funnels/${customer.funnelId}/journeys`);
  expect(journeysResponse.status()).toBe(200); const { journeys } = await journeysResponse.json();
  expect(journeys).toHaveLength(2);
  expect(journeys.find((journey: {subjectId: string}) => journey.subjectId === customer.subjectIds[0]).currentStageKey).toBe("qualified");
  expect(journeys.find((journey: {subjectId: string}) => journey.subjectId === customer.subjectIds[1]).currentStageKey).toBe("lead");
  await page.reload(); await page.getByRole("listitem").filter({ hasText: `Subject ${customer.subjectIds[0]} · cycle 1` }).getByRole("button", { name: "Inspect journey 1", exact: true }).click();
  await expect(page.getByRole("region", { name: "Journey history", exact: true })).toContainText("Customer booked a discovery call by phone");
  expect(await providerStats(page)).toEqual(before);
  await page.setViewportSize({ width: 320, height: 740 }); await noHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath("funnel-two-enquiries-320.png"), fullPage: true, animations: "disabled" });

  await page.getByRole("combobox", { name: "Destination stage", exact: true }).selectOption("won");
  await page.getByLabel("Reason", { exact: true }).fill("First enquiry completed");
  await page.getByRole("button", { name: "Record tracking-only move", exact: true }).click();
  await expect(history).toContainText("First enquiry completed");
  await page.getByLabel("Explicitly start a new cycle after a finished journey", { exact: true }).check();
  await page.getByRole("combobox", { name: "Destination stage", exact: true }).selectOption("lead");
  await page.getByLabel("Reason", { exact: true }).fill("Customer explicitly requested a second engagement");
  await page.getByRole("button", { name: "Record tracking-only move", exact: true }).click();
  await expect(history).toContainText("cycle 2");
  const current = (await (await page.request.get(`/api/funnels/${customer.funnelId}/journeys`)).json()).journeys;
  expect(current).toHaveLength(3);
  const secondCycle = current.find((journey: { subjectId: string; cycle: number }) => journey.subjectId === customer.subjectIds[0] && journey.cycle === 2);
  await page.getByRole("listitem").filter({ hasText: `Subject ${customer.subjectIds[0]} · cycle 1` }).getByRole("button", { name: "Inspect journey 1", exact: true }).click();
  await expect(history).toContainText("cycle 1");
  await page.getByRole("combobox", { name: "Destination stage", exact: true }).selectOption("qualified");
  await page.getByLabel("Reason", { exact: true }).fill("Historical inspection must not change the current cycle");
  const rejected = page.waitForResponse(response => new URL(response.url()).pathname === `/api/funnels/${customer.funnelId}/move`);
  await page.getByRole("button", { name: "Record tracking-only move", exact: true }).click();
  expect((await rejected).status()).toBe(409);
  await expect(page.getByRole("alert").filter({ hasText: /journey|cycle|changed/i })).toBeVisible();
  const after = (await (await page.request.get(`/api/funnels/${customer.funnelId}/journeys`)).json()).journeys;
  expect(after.find((journey: { id: string }) => journey.id === secondCycle.id)).toEqual(secondCycle);
  expect(await providerStats(page)).toEqual(before);
});

test("main app navigation opens funnels and protects unfinished edits on desktop and mobile", async ({ page }, info) => {
  const customer = await signIn(page, info), before = await providerStats(page);
  await page.goto("/dashboard");
  const navigation = page.getByRole("navigation", { name: "Global navigation", exact: true });
  await expect(page.getByRole("heading", { name: "A clear view of what’s next.", exact: true })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "Home", exact: true })).toHaveAttribute("aria-current", "page");
  await navigation.getByRole("link", { name: "Funnels", exact: true }).click();
  await expect(page).toHaveURL(/\/funnels\?environment=TEST$/);
  await expect(navigation.getByRole("link", { name: "Funnels", exact: true })).toHaveAttribute("aria-current", "page");
  await page.getByRole("link", { name: "Consultation journey", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/funnels/${customer.funnelId}$`));
  await expect(navigation.getByRole("link", { name: "Funnels", exact: true })).toHaveAttribute("aria-current", "page");
  const stageName = page.getByLabel("Stage name", { exact: true });
  await stageName.fill("Unfinished navigation review");
  page.once("dialog", dialog => dialog.dismiss());
  await navigation.getByRole("link", { name: "Home", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/funnels/${customer.funnelId}$`));
  await expect(stageName).toHaveValue("Unfinished navigation review");
  await page.screenshot({ path: info.outputPath("integrated-funnel-desktop.png"), fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 320, height: 740 });
  const menu = page.getByRole("button", { name: "More", exact: true });
  await menu.focus(); await page.keyboard.press("Enter");
  const mobileNavigation = page.getByRole("navigation", { name: "More workspace navigation", exact: true });
  await expect(mobileNavigation).toBeVisible();
  await expect(mobileNavigation.getByRole("link", { name: "Funnels", exact: true })).toHaveAttribute("aria-current", "page");
  await noHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath("integrated-funnel-menu-320.png"), animations: "disabled" });
  page.once("dialog", dialog => dialog.dismiss());
  await mobileNavigation.getByRole("link", { name: "Campaigns", exact: true }).click();
  await expect(stageName).toHaveValue("Unfinished navigation review");
  page.once("dialog", dialog => dialog.accept());
  await mobileNavigation.getByRole("link", { name: "Home", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { name: "A clear view of what’s next.", exact: true })).toBeVisible();
  expect((await readFunnel(page, customer.funnelId)).draft.stages[0].name).not.toBe("Unfinished navigation review");
  expect(await providerStats(page)).toEqual(before);
});

test("main navigation keeps the selected environment across funnels, tracking and email", async ({ page }, info) => {
  await signIn(page, info);
  const before = await providerStats(page);
  await page.getByRole("combobox", { name: "Environment", exact: true }).selectOption("LIVE");
  await page.getByRole("navigation", { name: "Funnel navigation", exact: true }).getByRole("link", { name: "Tracking sources", exact: true }).click();
  await expect(page).toHaveURL(/\/tracking\?environment=LIVE$/);
  await expect(page.getByRole("combobox", { name: "Environment", exact: true })).toHaveValue("LIVE");
  await page.getByRole("textbox", { name: "Search quick actions", exact: true }).fill("Email campaigns");
  await page.getByRole("link", { name: /Email campaigns Manage sequences/ }).click();
  await expect(page).toHaveURL(/\/email\?environment=LIVE$/);
  await expect(page.getByRole("combobox", { name: "Environment", exact: true })).toHaveValue("LIVE");
  await page.getByRole("navigation", { name: "Global navigation", exact: true }).getByRole("link", { name: "Funnels", exact: true }).click();
  await expect(page).toHaveURL(/\/funnels\?environment=LIVE$/);
  await expect(page.getByRole("combobox", { name: "Environment", exact: true })).toHaveValue("LIVE");
  await page.getByRole("combobox", { name: "Environment", exact: true }).selectOption("TEST");
  await expect(page.getByRole("link", { name: "Consultation journey", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Funnel navigation", exact: true }).getByRole("link", { name: "Tracking sources", exact: true })).toHaveAttribute("href", "/tracking?environment=TEST");
  expect(await providerStats(page)).toEqual(before);
});

test("canvas connections require evidence and layout controls leave the saved rules unchanged", async ({ page }, info) => {
  const customer = await signIn(page, info), before = await providerStats(page);
  const definition: FunnelDefinition = { schemaVersion: 1, stages: [
    { id: "inquiry", name: "New inquiry", goal: false, terminal: "NONE" },
    { id: "booked", name: "Call booked", goal: true, terminal: "NONE" },
  ], entryStages: ["inquiry"], routes: [] };
  const response = await page.request.post("/api/funnels", { headers: { Origin: new URL(page.url()).origin }, data: { name: "Canvas connection review", environment: "TEST", subjectKind: "SALES", definition } });
  expect(response.status()).toBe(201);
  const created = await response.json();
  await page.goto(`/funnels/${created.id}`);
  const canvas = page.getByTestId("funnel-canvas");
  await expect(canvas.locator('.react-flow__node[data-id="inquiry"]')).toBeVisible();
  const connect = async () => {
    await canvas.locator('.react-flow__node[data-id="inquiry"] .react-flow__handle.source').click();
    await canvas.locator('.react-flow__node[data-id="booked"] .react-flow__handle.target').click();
  };
  await connect();
  const connection = page.getByRole("region", { name: "Connect stages", exact: true });
  await expect(connection).toBeVisible();
  await expect(connection.getByRole("button", { name: "Add connection rule", exact: true })).toBeDisabled();
  expect((await readFunnel(page, created.id)).draft.routes).toEqual([]);
  await connection.getByRole("button", { name: "Cancel connection", exact: true }).click();
  await expect(connection).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
  await connect();
  await connection.getByRole("combobox", { name: "Connection source", exact: true }).selectOption(customer.sourceId);
  await connection.getByRole("combobox", { name: "Connection event", exact: true }).selectOption("enquiry.accepted");
  await connection.getByRole("button", { name: "Add connection rule", exact: true }).click();
  const saveResponse = page.waitForResponse(response => response.request().method() === "PATCH" && new URL(response.url()).pathname === `/api/funnels/${created.id}`);
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  expect((await saveResponse).status()).toBe(200);
  await expect(page.getByRole("status").filter({ hasText: "Draft revision 2 saved" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
  const saved = await readFunnel(page, created.id);
  expect(saved.draft.routes).toHaveLength(1);
  expect(saved.draft.routes[0]).toMatchObject({ from: "inquiry", trigger: { kind: "EVENT", sourceId: customer.sourceId, type: "enquiry.accepted" }, fallback: { kind: "MOVE", to: "booked" } });
  await page.getByRole("button", { name: "Arrange stages", exact: true }).click();
  await page.getByRole("button", { name: "Zoom in on funnel", exact: true }).click();
  await page.getByRole("button", { name: "Fit all funnel stages", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
  expect(await readFunnel(page, created.id)).toEqual(saved);
  expect(saved.draft.stageActions ?? []).toEqual([]);
  expect(await providerStats(page)).toEqual(before);
});
