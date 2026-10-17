import assert from "node:assert/strict";
import { test } from "node:test";
import { campaignChannels, campaignFromDTO, campaignStepError, changeCampaignType, emptyCampaign, structureCampaignBrief, syncCampaignCreatives, validCampaignUrl } from "../../apps/web/src/components/workspace/campaignBuilderState";
import type { CampaignDTO } from "../../apps/web/src/server/workspace/types";

test("switching from social to ads drops incompatible channels, creatives and scheduling while preserving the brief", () => {
  const initial = { ...emptyCampaign, brief: "Make a collection launch for returning customers", platforms: ["TIKTOK"], creatives: [{ platform: "TIKTOK", title: "A new collection", body: "Social copy", cta: "Explore", format: "SHORT_VIDEO" }], plan: { cadence: "7", timeZone: "Europe/London", totalBudget: "500" } };
  const next = changeCampaignType(initial, "ADS");
  assert.equal(next.brief, initial.brief);
  assert.deepEqual(next.platforms, []);
  assert.deepEqual(next.creatives, []);
  assert.equal(next.plan.totalBudget, undefined);
  assert.equal(next.plan.timeZone, "Europe/London");
  assert.deepEqual(campaignChannels[next.type].map((channel) => channel.id), ["GOOGLE", "META"]);
  assert.deepEqual(initial.platforms, ["TIKTOK"]);
});

test("email and blog branches have an editable creative without a channel toggle", () => {
  for (const type of ["EMAIL", "BLOG"] as const) {
    const campaign = changeCampaignType(emptyCampaign, type);
    assert.deepEqual(campaign.platforms, [type]);
    assert.equal(campaign.creatives.length, 1);
    assert.equal(campaign.creatives[0].platform, type);
    assert.match(campaignStepError(campaign, 5)!, /content draft/);
  }
});

test("channel changes retain authored copy for retained channels and create channel appropriate new drafts", () => {
  const campaign = syncCampaignCreatives({ ...emptyCampaign, platforms: ["LINKEDIN", "YOUTUBE"], creatives: [{ platform: "LINKEDIN", title: "Launch", body: "An authored announcement", cta: "Read more", format: "TEXT" }, { platform: "X", title: "", body: "Removed copy", cta: "", format: "TEXT" }] });
  assert.equal(campaign.creatives[0].body, "An authored announcement");
  assert.equal(campaign.creatives[1].format, "SHORT_VIDEO");
  assert.equal(campaign.creatives.some((creative) => creative.platform === "X"), false);
});

test("campaign links accept explicit web URLs and reject credentials and executable schemes", () => {
  for (const url of ["javascript:alert(1)", "data:text/html,hello", "ftp://example.com", "https://user:password@example.com", "example.com"]) assert.equal(validCampaignUrl(url), false);
  for (const url of ["https://example.com/collection", "http://localhost:3156/product"]) assert.equal(validCampaignUrl(url), true);
});

test("budget, cadence and date validation keep incomplete plans from review", () => {
  assert.match(campaignStepError({ ...emptyCampaign, type: "ADS", plan: { totalBudget: "Infinity" } }, 4)!, /budget/);
  assert.match(campaignStepError({ ...emptyCampaign, plan: { cadence: "2.5" } }, 4)!, /posts per week/);
  assert.match(campaignStepError({ ...emptyCampaign, plan: { cadence: "3", startDate: "2026-02-31" } }, 4)!, /valid start/);
  assert.match(campaignStepError({ ...emptyCampaign, plan: { cadence: "3", startDate: "2026-10-20", endDate: "2026-10-19" } }, 4)!, /end date/);
  assert.equal(campaignStepError({ ...emptyCampaign, type: "ADS", plan: { totalBudget: "12.50" } }, 4), null);
});

test("review requires content for every chosen channel, not just one populated draft", () => {
  const campaign = syncCampaignCreatives({ ...emptyCampaign, platforms: ["LINKEDIN", "X"], creatives: [{ platform: "LINKEDIN", title: "Launch", body: "Hello", cta: "", format: "TEXT" }] });
  assert.match(campaignStepError(campaign, 5)!, /every selected channel/);
  campaign.creatives[1].body = "X announcement";
  assert.equal(campaignStepError(campaign, 5), null);
});

test("saved flexible content is normalized safely and missing channel drafts are restored", () => {
  const dto = { ...emptyCampaign, id: "saved", type: "SOCIAL", platforms: ["YOUTUBE", "LINKEDIN"], creatives: [{ platform: "YOUTUBE", title: 12, body: "Kept caption", cta: null }], plan: {}, status: "DRAFT", version: 1, createdAt: "", updatedAt: "", linkedPosts: [], socialPostIds: [], execution: { mode: "SOCIAL_APPROVAL", message: "" } } as unknown as CampaignDTO;
  const state = campaignFromDTO(dto);
  assert.equal(state.creatives[0].title, "");
  assert.equal(state.creatives[0].body, "Kept caption");
  assert.equal(state.creatives[0].format, "SHORT_VIDEO");
  assert.equal(state.creatives[1].platform, "LINKEDIN");
  assert.equal(state.plan.cadence, "3");
});

test("the brief writing aid preserves provided facts and labels prompts to complete", () => {
  const brief = "Introduce our repair programme; do not promise a specific turnaround time.";
  const result = structureCampaignBrief(brief);
  assert.ok(result.includes(brief));
  assert.ok(result.includes("Describe the offer and the evidence that supports it."));
  assert.ok(result.includes("Brand guidance"));
});

test("all four builder branches save and reload their exact draft payload through the authenticated workspace API", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createClient } = await import("@libsql/client");
  const { applyConnectionMigrations } = await import("../support/test-database");
  const { PrismaClient } = await import("../../apps/web/src/generated/prisma/client");
  const { LocalSqliteAdapter } = await import("../../apps/web/src/server/prisma/localSqliteAdapter");
  const { CustomerAuth } = await import("../../apps/web/src/server/auth/customerAuth");
  const { createWorkspaceApi } = await import("../../apps/web/src/server/workspace/api");
  const { WorkspaceService } = await import("../../apps/web/src/server/workspace/service");
  const directory = await mkdtemp(join(tmpdir(), "campaign-builder-contract-"));
  const url = `file:${join(directory, "contract.db")}`;
  const client = createClient({ url });
  await applyConnectionMigrations(client); client.close();
  const db = new PrismaClient({ adapter: new LocalSqliteAdapter({ url }) });
  try {
    const origin = "https://builder.test";
    const auth = new CustomerAuth(db, { origin });
    await auth.provisionCustomer({ name: "Builder test", email: "builder@example.test", password: "Builder contract password" });
    const login = await auth.login("builder@example.test", "Builder contract password");
    const api = createWorkspaceApi(auth, new WorkspaceService(db));
    const request = (path: string, method: string, body?: unknown) => new Request(`${origin}/api/workspace/campaigns${path}`, { method, headers: { cookie: login.cookie.split(";")[0], origin, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    for (const type of ["SOCIAL", "ADS", "EMAIL", "BLOG"] as const) {
      let state = changeCampaignType({ ...emptyCampaign, name: `${type} collection launch`, websiteUrl: "https://example.test/collection", brief: "Introduce the new collection to returning customers.", audience: "Returning customers in London" }, type);
      state = syncCampaignCreatives({ ...state, platforms: type === "SOCIAL" ? ["YOUTUBE", "LINKEDIN"] : type === "ADS" ? ["GOOGLE", "META"] : [type] });
      const created = await api(request("", "POST", { ...state, status: "DRAFT" }));
      assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
      const draft = (await created.json()).campaign as CampaignDTO;
      state.creatives = state.creatives.map((creative) => ({ ...creative, title: "Introducing our collection", body: "Explore the new collection, crafted for returning customers.", cta: "Explore the collection" }));
      state.plan = { ...state.plan, totalBudget: "1250.00", startDate: "2026-10-20", endDate: "2026-11-20" };
      for (let step = 1; step <= 5; step++) assert.equal(campaignStepError(state, step), null);
      const saved = await api(request(`/${draft.id}`, "PATCH", { ...state, version: draft.version, status: "READY" }));
      assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));
      const reloaded = (await (await api(request(`/${draft.id}`, "GET"))).json()).campaign as CampaignDTO;
      assert.equal(reloaded.status, "READY");
      assert.deepEqual(campaignFromDTO(reloaded), state);
      const stale = await api(request(`/${draft.id}`, "PATCH", { ...state, version: draft.version, status: "DRAFT" }));
      assert.equal(stale.status, 409);
    }
  } finally { await db.$disconnect(); await rm(directory, { recursive: true, force: true }); }
});
