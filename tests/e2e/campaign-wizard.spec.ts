import { randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { CampaignWizardPage } from "../support/page-objects/campaign-wizard-page";
import { signInTestCustomer } from "../support/helpers/customer-session";
import { resolveBaseUrl } from "../support/helpers/env";
import type { CampaignDTO } from "../../apps/web/src/server/workspace/types";

const brief = "Introduce our autumn collection to returning customers and invite them to explore the range.";
async function readCampaign(request: APIRequestContext, id: string): Promise<CampaignDTO> {
  const response = await request.get(`/api/workspace/campaigns/${id}`);
  expect(response.ok()).toBe(true);
  return (await response.json()).campaign;
}
async function seedCampaign(request: APIRequestContext, overrides: Record<string, unknown> = {}): Promise<CampaignDTO> {
  const response = await request.post("/api/workspace/campaigns", { headers: { Origin: resolveBaseUrl() }, data: {
    type: "SOCIAL", name: `Campaign ${randomUUID()}`, websiteUrl: "https://example.test/collection", brief,
    goal: "traffic", audience: "Returning customers in London", platforms: ["LINKEDIN"],
    plan: { cadence: "3", timeZone: "Europe/London" }, creatives: [{ platform: "LINKEDIN", title: "Original title", body: "Original authored caption.", cta: "Explore", format: "TEXT" }], ...overrides,
  } });
  expect(response.status()).toBe(201);
  return (await response.json()).campaign;
}
async function toChannels(wizard: CampaignWizardPage, type: "Social campaign" | "Paid advertising" | "Email campaign" | "Content / blog", name: string) {
  await wizard.visit(); await wizard.chooseType(type); await wizard.continueToNextStep();
  await wizard.fillBrief(name, brief); await wizard.continueToNextStep();
  await wizard.fillAudience(); await wizard.continueToNextStep();
  await expect(wizard.stepTitle).toHaveText("Choose your channels");
}
async function applyGenerated(wizard: CampaignWizardPage) {
  await wizard.generateCreatives();
  await expect(wizard.page.getByRole("region", { name: "Generated drafts preview" })).toBeVisible();
  await wizard.page.getByRole("button", { name: "Apply generated drafts", exact: true }).click();
}

test.describe("durable campaign builder", () => {
  test.beforeEach(async ({ request, context }, testInfo) => { await signInTestCustomer(request, testInfo.project.name, context, "wizard"); });

  test("social planning preserves original copy until preview approval, reloads the current step and saves a real campaign", async ({ page, request, campaignWizardPage: wizard }) => {
    test.setTimeout(120000);
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    const name = `Autumn social ${randomUUID()}`;
    await wizard.visit(); await wizard.continueToNextStep(); await wizard.fillBrief(name, brief);
    await page.getByRole("button", { name: "Enhance brief", exact: true }).click();
    await expect(page.getByRole("region", { name: "Brief enhancement preview" })).toContainText(brief);
    await expect(page.getByLabel("Campaign brief")).toHaveValue(brief);
    await page.getByRole("button", { name: "Keep original", exact: true }).click();
    await expect(page.getByLabel("Campaign brief")).toHaveValue(brief);
    await page.getByRole("button", { name: "Enhance brief", exact: true }).click();
    await page.getByRole("button", { name: "Apply enhanced brief", exact: true }).click();
    const enhanced = await page.getByLabel("Campaign brief").inputValue();
    expect(enhanced).toContain(brief); expect(enhanced).not.toBe(brief);
    await wizard.continueToNextStep();
    const id = wizard.campaignId();
    await page.reload();
    await expect(wizard.stepTitle).toHaveText("Who should this reach?");
    expect(new URL(page.url()).searchParams.get("step")).toBe("2");
    await wizard.fillAudience(); await wizard.continueToNextStep();
    await wizard.chooseChannel("YouTube Shorts"); await wizard.chooseChannel("LinkedIn");
    await expect(wizard.root.getByRole("checkbox", { name: /^Google Ads/ })).toHaveCount(0);
    await wizard.continueToNextStep();
    await page.getByLabel("Planned posts per week").fill("4"); await wizard.continueToNextStep();
    const caption = page.getByLabel("Published caption / description");
    await caption.fill("My original video caption.");
    await wizard.generateCreatives();
    await expect(page.getByRole("region", { name: "Generated drafts preview" })).toContainText("Demo");
    await expect(caption).toHaveValue("My original video caption.");
    await page.getByRole("button", { name: "Keep original drafts", exact: true }).click();
    await expect(caption).toHaveValue("My original video caption.");
    await applyGenerated(wizard);
    await expect(caption).not.toHaveValue("My original video caption.");
    await wizard.continueToNextStep();
    await expect(wizard.stepTitle).toHaveText("Review your campaign");
    await expect(wizard.root).toContainText("4 planned posts per week");
    await page.getByRole("button", { name: "Save campaign", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/campaigns/${id}$`));
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    const saved = await readCampaign(request, id);
    expect(saved).toMatchObject({ name, type: "SOCIAL", status: "READY", brief: enhanced, platforms: ["YOUTUBE", "LINKEDIN"], plan: { cadence: "4" } });
    expect(saved.creatives).toHaveLength(2); expect(saved.linkedPosts).toEqual([]);
    await page.getByRole("link", { name: /Prepare social post/ }).click();
    await expect(page).toHaveURL(new RegExp(`/social/create\\?campaignId=${id}$`));
    await expect(page.getByLabel(/^Draft title/)).toHaveValue(name);
    expect(errors).toEqual([]);
  });

  test("paid campaigns offer Google and Meta before budget and remain saved plans without enabled ad writes", async ({ page, request, campaignWizardPage: wizard }) => {
    const writes: string[] = [];
    page.on("request", request => { if (/\/api\/ads\/(create|update|delete|launch)/.test(new URL(request.url()).pathname)) writes.push(request.url()); });
    await toChannels(wizard, "Paid advertising", `Paid plan ${randomUUID()}`);
    await wizard.chooseChannel("Google Ads"); await wizard.chooseChannel("Meta Ads");
    await expect(wizard.root.getByRole("checkbox", { name: /TikTok|YouTube/ })).toHaveCount(0);
    await wizard.continueToNextStep();
    await expect(wizard.stepTitle).toHaveText("Set your budget and timing");
    await page.getByLabel("Total planned budget").fill("1275.50");
    await page.getByRole("combobox", { name: "Currency", exact: true }).selectOption("GBP");
    await wizard.continueToNextStep(); await applyGenerated(wizard); await wizard.continueToNextStep();
    await expect(wizard.root).toContainText("Campaign creation and ad spending are currently disabled");
    await expect(page.getByRole("button", { name: "Check connected ad accounts" })).toBeDisabled();
    const id = wizard.campaignId();
    await page.getByRole("button", { name: "Save campaign", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/campaigns/${id}$`));
    expect(await readCampaign(request, id)).toMatchObject({ type: "ADS", status: "READY", platforms: ["GOOGLE", "META"], plan: { totalBudget: "1275.50", currency: "GBP" }, execution: { mode: "ADS_API" } });
    expect(writes).toEqual([]);
  });

  for (const branch of [{ type: "EMAIL", label: "Email campaign", titleLabel: "Subject line" }, { type: "BLOG", label: "Content / blog", titleLabel: "Article title" }] as const) {
    test(`${branch.type.toLowerCase()} campaigns create durable content drafts with truthful delivery limits`, async ({ page, request, campaignWizardPage: wizard }) => {
      await toChannels(wizard, branch.label, `${branch.type} campaign ${randomUUID()}`);
      await expect(wizard.root).toContainText("This campaign supports drafting.");
      await wizard.continueToNextStep(); await wizard.continueToNextStep();
      await expect(page.getByLabel(branch.titleLabel, { exact: true })).toBeVisible();
      await applyGenerated(wizard); await wizard.continueToNextStep();
      await expect(wizard.root).toContainText(branch.type === "EMAIL" ? "Email delivery is not connected yet" : "Website publication is not connected yet");
      const id = wizard.campaignId(); await page.getByRole("button", { name: "Save campaign", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/campaigns/${id}$`));
      const saved = await readCampaign(request, id);
      expect(saved).toMatchObject({ type: branch.type, platforms: [branch.type], execution: { mode: "DRAFT_ONLY" }, status: "READY" });
      expect(saved.creatives[0].body).toBeTruthy();
    });
  }

  test("brief and channel validation block incomplete progress and preserve saved context", async ({ page, campaignWizardPage: wizard }) => {
    await wizard.visit(); await wizard.continueToNextStep();
    await wizard.continueButton.click(); await expect(wizard.root.getByRole("alert")).toContainText("Give your campaign a name");
    await wizard.fillBrief(`Validation ${randomUUID()}`, "Too short");
    await page.getByLabel("Website or product URL").fill("javascript:alert(1)");
    await wizard.continueButton.click(); await expect(wizard.root.getByRole("alert")).toContainText("https:// or http://");
    await page.getByLabel("Website or product URL").fill("https://example.test");
    await wizard.continueButton.click(); await expect(wizard.root.getByRole("alert")).toContainText("at least 20 characters");
    await page.getByLabel("Campaign brief").fill(brief); await wizard.continueToNextStep();
    await wizard.continueButton.click(); await expect(wizard.root.getByRole("alert")).toContainText("Describe who");
    await wizard.fillAudience(); await wizard.continueToNextStep();
    await wizard.continueButton.click(); await expect(wizard.root.getByRole("alert")).toContainText("Choose at least one channel");
    await wizard.goBack(); await expect(page.getByLabel("Audience description")).toHaveValue("Returning customers in London who enjoy independent design.");
  });

  test("assistant failure leaves authored content intact and draft saves can retry safely", async ({ page, request, campaignWizardPage: wizard }) => {
    const campaign = await seedCampaign(request);
    await wizard.visit(`?id=${campaign.id}&step=5`);
    await page.route("**/api/workspace/assist", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Suggestions are temporarily unavailable." }) }));
    await wizard.generateCreatives();
    await expect(wizard.root.getByRole("alert")).toContainText("Suggestions are temporarily unavailable.");
    await expect(page.getByLabel(/^Copy \/ caption/)).toHaveValue("Original authored caption.");
    let attempts = 0; const submitted: unknown[] = [];
    await page.route(`**/api/workspace/campaigns/${campaign.id}`, async route => {
      if (route.request().method() !== "PATCH") return route.continue();
      attempts++; submitted.push(route.request().postDataJSON());
      if (attempts === 1) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Draft storage is temporarily unavailable." }) });
      await route.continue();
    });
    await page.getByLabel(/^Copy \/ caption/).fill("My edited caption stays intact.");
    await wizard.continueButton.click(); await expect(wizard.root.getByRole("alert")).toContainText("Draft storage is temporarily unavailable.");
    await expect(page.getByLabel(/^Copy \/ caption/)).toHaveValue("My edited caption stays intact.");
    await wizard.continueToNextStep(); expect(attempts).toBe(2); expect(submitted[1]).toEqual(submitted[0]);
    expect((await readCampaign(request, campaign.id)).creatives[0].body).toBe("My edited caption stays intact.");
  });

  test("sidebar navigation saves edits, a fresh create action resets the editor, and stale revisions cannot overwrite newer work", async ({ page, request, campaignWizardPage: wizard }) => {
    const campaign = await seedCampaign(request);
    await wizard.visit(`?id=${campaign.id}&step=1`);
    const newName = `Saved when leaving ${randomUUID()}`;
    await page.getByLabel("Campaign name", { exact: true }).fill(newName);
    await page.getByRole("navigation", { name: "Global navigation", exact: true }).getByRole("link", { name: "Campaigns", exact: true }).click();
    await expect(page).toHaveURL(/\/campaigns$/);
    expect((await readCampaign(request, campaign.id)).name).toBe(newName);
    await wizard.visit(`?id=${campaign.id}&step=1`);
    await page.locator(".topbar-create").click();
    await expect(page).toHaveURL(/\/campaigns\/create$/);
    await expect(wizard.stepTitle).toHaveText("What are we creating?");
    await wizard.continueToNextStep(); await expect(page.getByLabel("Campaign name", { exact: true })).toHaveValue("");
    await wizard.visit(`?id=${campaign.id}&step=1`);
    await page.getByLabel("Campaign name", { exact: true }).fill("Local unsaved name");
    const latest = await readCampaign(request, campaign.id);
    const changed = await request.patch(`/api/workspace/campaigns/${campaign.id}`, { headers: { Origin: resolveBaseUrl() }, data: { version: latest.version, name: "Newer server version" } }); expect(changed.ok()).toBe(true);
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await expect(wizard.root.getByRole("alert")).toContainText("changed in another window");
    await expect(page.getByLabel("Campaign name", { exact: true })).toHaveValue("Local unsaved name");
    expect((await readCampaign(request, campaign.id)).name).toBe("Newer server version");
  });

  test("customer draft APIs reject another customer's reads, writes and cross-site mutations", async ({ request, playwright }, testInfo) => {
    const campaign = await seedCampaign(request);
    const other = await playwright.request.newContext({ baseURL: resolveBaseUrl() });
    try {
      await signInTestCustomer(other, testInfo.project.name, undefined, "other");
      expect((await other.get(`/api/workspace/campaigns/${campaign.id}`)).status()).toBe(404);
      expect((await other.patch(`/api/workspace/campaigns/${campaign.id}`, { headers: { Origin: resolveBaseUrl() }, data: { version: campaign.version, name: "Foreign edit" } })).status()).toBe(404);
      expect((await request.patch(`/api/workspace/campaigns/${campaign.id}`, { headers: { Origin: "https://other.example" }, data: { version: campaign.version, name: "Cross-site edit" } })).status()).toBe(403);
      expect((await readCampaign(request, campaign.id)).name).toBe(campaign.name);
    } finally { await other.dispose(); }
  });
});
