import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { Connection } from "../../apps/web/src/components/connections/connectionUi";
import type { SocialPost } from "../../apps/web/src/components/social/socialUi";

type Provider = "youtube" | "meta-publishing" | "tiktok" | "linkedin" | "x";
interface FixtureInfo {
  imagePath: string; videoPath: string; imageBytes: number; videoBytes: number;
  providerOrigins: Record<Provider, string>;
}
const expectedCounts = {
  youtube: { "qa-start": "1", "qa-complete": "1" },
  "meta-publishing": { photos: "1", feeds: "1", containers: "1", igPublishes: "1" },
  tiktok: { "qa-init": "1" },
  linkedin: { "qa-image-upload": "1", "qa-video-upload": "1", "qa-member": "1", "qa-organization": "1" },
  x: { "qa-create": "1", "qa-image-upload": "1", "qa-unknown-submit": "0" },
};
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const futureUtcInput = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString().slice(0, 16);
async function noHorizontalOverflow(page: Page) {
  const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
    offenders: [...document.querySelectorAll<HTMLElement>("body *")].map((element) => {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      return { tag: element.tagName, text: element.textContent?.trim().slice(0, 90), className: String(element.className),
        right: Math.round(rect.right), width: Math.round(rect.width), visible: rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" };
    }).filter((value) => value.visible && value.right > innerWidth + 1).slice(-30) }));
  expect(layout.scrollWidth, JSON.stringify(layout)).toBeLessThanOrEqual(layout.width);
}
async function post(page: Page, id: string): Promise<SocialPost> {
  const response = await page.request.get(`/api/social/posts/${id}`);
  expect(response.status()).toBe(200); return response.json();
}
async function approveWithKeyboard(page: Page, id: string) {
  const acknowledgment = page.getByRole("checkbox", { name: /^I reviewed revision \d+ and every destination variant$/ });
  await acknowledgment.focus(); await expect(acknowledgment).toBeFocused();
  await page.keyboard.press("Space"); await expect(acknowledgment).toBeChecked();
  const response = page.waitForResponse((value) => new URL(value.url()).pathname === `/api/social/posts/${id}/approve`);
  await page.getByRole("button", { name: "Approve saved revision", exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(page.getByRole("button", { name: "Revision reviewed", exact: true })).toBeVisible();
}

// This spec belongs to the dedicated, explicitly enabled Mockoon app runner.
// Every browser project gets a fresh app/provider set; publication IDs and
// duplicate guards must never be shared between concurrent browser projects.
test("customer publishes all seven reviewed destinations once, then schedules, reschedules and cancels future work", async ({ page }, info) => {
  test.setTimeout(240_000);
  expect(process.env.QA_FIXTURE_INFO, "The dedicated runner must provide public fixture metadata").toBeTruthy();
  const fixture: FixtureInfo = JSON.parse(await readFile(process.env.QA_FIXTURE_INFO!, "utf8"));
  expect(fixture.imageBytes).toBeGreaterThan(0); expect(fixture.videoBytes).toBeGreaterThan(0);
  for (const value of Object.values(fixture.providerOrigins)) {
    const url = new URL(value); expect(url.protocol).toBe("http:"); expect(url.hostname).toBe("127.0.0.1");
  }
  expect(JSON.stringify(fixture)).not.toMatch(/accessToken|refreshToken|secret|signingKey|tokenKey|Ciphertext/i);
  const advertisingWrites: string[] = [];
  page.on("request", (request) => { const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && (path.startsWith("/api/ads/") || path.startsWith("/api/campaigns"))) advertisingWrites.push(path); });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/sign-in?returnTo=%2Fconnections");
  await page.getByLabel(/^Email/).fill(`qa-${info.project.name}@example.test`);
  await page.getByLabel(/^Password/).fill("all platform actual HTTP fixture password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/connections$/);
  // Continue actual consent to the explicit private TikTok fixture scenario.
  // No app or provider response is fulfilled or replaced by this test.
  await page.route((url) => url.pathname === "/v2/auth/authorize/", async (route) => {
    const url = new URL(route.request().url()); expect(url.origin).toBe(fixture.providerOrigins.tiktok);
    url.searchParams.set("fixture_consent", "private"); await route.continue({ url: url.href });
  });
  const social = page.getByTestId("social-connections");
  for (const [provider, label] of [["youtube", "YouTube Shorts"], ["meta-publishing", "Facebook Pages"], ["tiktok", "TikTok"], ["linkedin", "LinkedIn"], ["x", "X"]] as const) {
    if (provider === "x") {
      await expect(social.getByRole("button", { name: "Connect X", exact: true })).toBeDisabled();
      await page.getByLabel("Maximum X connection API cost (USD)", { exact: true }).fill("0.05");
    }
    const callback = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/connections/${provider}/callback`);
    await social.getByRole("button", { name: `Connect ${label}`, exact: true }).click();
    expect((await callback).status()).toBe(303);
    await expect(page).toHaveURL(new RegExp(`/connections\\?provider=${provider}&result=connected`));
  }
  const connectionsResponse = await page.request.get("/api/connections"); expect(connectionsResponse.status()).toBe(200);
  const connections: Connection[] = await connectionsResponse.json();
  expect(connections).toHaveLength(5);
  expect(connections.every((value) => value.capability === "SOCIAL" && value.connectionMode === "MOCK")).toBe(true);
  const available = connections.flatMap((value) => value.destinations).filter((value) => value.available && value.metadata?.canWrite === "ALLOWED");
  expect(available.map((value) => value.kind).sort()).toEqual(["FACEBOOK_PAGE", "INSTAGRAM_PROFILE", "LINKEDIN_MEMBER", "LINKEDIN_ORGANIZATION", "TIKTOK_PROFILE", "X_PROFILE", "YOUTUBE_CHANNEL"]);
  for (const destination of available) {
    const row = social.getByTestId("connection-destination").filter({ has: page.getByRole("heading", { name: destination.name!, exact: true }) });
    await row.getByRole("button", { name: "Select account", exact: true }).click();
    await expect(row.getByRole("button", { name: "Deselect account", exact: true })).toBeVisible();
  }
  await expect(page.getByTestId("paid-connections").getByTestId("provider-connection")).toHaveCount(0);
  await noHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath("all-social-connections-mobile.png") });
  await page.goto("/social/create");
  await page.getByLabel(/^Draft title/).fill("All seven customer-reviewed fixture destinations");
  await page.getByLabel("Caption or post text", { exact: true }).fill("Reviewed source caption");
  const upload = async (path: string, bytes: number, type: "IMAGE" | "VIDEO") => {
    const received = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/social/media" && response.request().method() === "POST");
    await page.getByLabel("Upload image or video", { exact: true }).setInputFiles(path);
    const response = await received; expect(response.status()).toBe(201); const asset = await response.json();
    expect(asset).toMatchObject({ bytes, type, width: 720, height: 1280, mime: type === "IMAGE" ? "image/png" : "video/mp4" });
    if (type === "VIDEO") { expect(asset.durationMs).toBeGreaterThanOrEqual(2900); expect(asset.durationMs).toBeLessThanOrEqual(3100); }
    return asset;
  };
  const image = await upload(fixture.imagePath, fixture.imageBytes, "IMAGE"), video = await upload(fixture.videoPath, fixture.videoBytes, "VIDEO");
  const definitions: Record<string, { format: "IMAGE" | "SHORT_VIDEO"; body: string; title?: string }> = {
    YOUTUBE_CHANNEL: { format: "SHORT_VIDEO", title: "Adapter private", body: "Synthetic fixture" },
    FACEBOOK_PAGE: { format: "IMAGE", body: "Reviewed Facebook caption" },
    INSTAGRAM_PROFILE: { format: "SHORT_VIDEO", body: "Reviewed Instagram caption" },
    TIKTOK_PROFILE: { format: "SHORT_VIDEO", body: "fixture-private" },
    LINKEDIN_MEMBER: { format: "IMAGE", body: "Image fixture" },
    LINKEDIN_ORGANIZATION: { format: "SHORT_VIDEO", body: "Organization video fixture" },
    X_PROFILE: { format: "IMAGE", body: "Fixture image" },
  };
  for (const destination of available) {
    const name = destination.name!, definition = definitions[destination.kind];
    await page.getByRole("checkbox", { name: new RegExp(`^${escaped(name)}(?:\\s|$)`) }).check();
    await page.getByLabel(`Format for ${name}`, { exact: true }).selectOption(definition.format);
    if (definition.title) await page.getByLabel(`Published title for ${name}`, { exact: true }).fill(definition.title);
    await page.getByLabel(`Caption for ${name}`, { exact: true }).fill(definition.body);
    await page.getByRole("group", { name: `Attachments for ${name}`, exact: true }).getByRole("checkbox", {
      name: definition.format === "IMAGE" ? image.filename : video.filename, exact: true,
    }).check();
    if (destination.kind === "YOUTUBE_CHANNEL") {
      await page.getByLabel("YouTube category ID", { exact: true }).fill("22");
      await page.getByLabel("YouTube privacy", { exact: true }).selectOption("private");
      await page.getByLabel("Made for kids", { exact: true }).selectOption("no");
      await page.getByLabel("Altered or synthetic content disclosure", { exact: true }).selectOption("yes");
    }
    if (destination.kind === "INSTAGRAM_PROFILE") await page.getByLabel("Also share the Reel to the Instagram feed", { exact: true }).selectOption("no");
    if (destination.kind.startsWith("LINKEDIN")) {
      // This newly added destination is the last LinkedIn variant. Earlier
      // authors retain their own independent visibility choice.
      await page.getByLabel("LinkedIn visibility", { exact: true }).last().selectOption("PUBLIC");
    }
    if (destination.kind === "X_PROFILE") {
      await page.getByLabel("Maximum X publishing API cost (USD)", { exact: true }).fill("1");
      await page.getByLabel("This X post was made with AI", { exact: true }).selectOption("no");
      await page.getByLabel("This X post is a paid partnership", { exact: true }).selectOption("no");
    }
  }
  // TikTok's exact posting consent is deliberately last: every content/media/
  // destination/options change before this point invalidates that consent.
  await expect(page.getByRole("heading", { name: /Fixture TikTok creator · @fixture_creator/ })).toBeVisible();
  await page.getByLabel("TikTok privacy", { exact: true }).selectOption("SELF_ONLY");
  await page.getByLabel("Allow TikTok comments", { exact: true }).selectOption("no");
  await expect(page.getByLabel("Allow TikTok Duet", { exact: true })).toHaveValue("no");
  await expect(page.getByLabel("Allow TikTok Stitch", { exact: true })).toHaveValue("no");
  await page.getByLabel("Does this TikTok post promote a brand, product, or service?", { exact: true }).selectOption("no");
  await page.getByRole("checkbox", { name: /^I agree to TikTok's Music Usage Confirmation/ }).check();
  await page.getByLabel("This TikTok video includes AI-generated content", { exact: true }).selectOption("no");
  await page.getByRole("checkbox", { name: /^I approve posting this exact video and caption to @fixture_creator\b/ }).check();
  const saved = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/social/posts" && response.request().method() === "POST");
  await page.getByRole("button", { name: "Save and review", exact: true }).click();
  const savedResponse = await saved; expect(savedResponse.status()).toBe(201); const reviewed: SocialPost = await savedResponse.json();
  expect(reviewed.publishingEnabled).toBe(true); expect(reviewed.revision.variants).toHaveLength(7);
  expect(reviewed.revision.variants.every((value) => value.publishingEnabled)).toBe(true);
  expect(reviewed.revision.variants.find((value) => value.kind === "TIKTOK_PROFILE")?.providerOptions?.explicitPostingConsent).toBe(true);
  await expect(page.getByRole("heading", { name: "Review social post", exact: true })).toBeVisible();
  await expect(page.getByText("US$1", { exact: true })).toBeVisible();
  await approveWithKeyboard(page, reviewed.id);
  const queued = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/social/posts/${reviewed.id}/enqueue`);
  await page.getByRole("button", { name: "Confirm and publish now", exact: true }).click();
  const queueResponse = await queued; expect(queueResponse.status()).toBe(200);
  expect((await queueResponse.json()).deliveries).toHaveLength(7);
  await expect.poll(async () => (await post(page, reviewed.id)).deliveries.filter((value) => value.status === "SUCCEEDED").length,
    { timeout: 90_000, intervals: [500, 1000, 2000] }).toBe(7);
  const done = await post(page, reviewed.id);
  expect(JSON.stringify(done)).not.toMatch(/accessToken|refreshToken|Ciphertext|uploadUrl|signature=|fixture-.*secret|storageKey/);
  expect(done.status).toBe("COMPLETED"); expect(done.deliveries.every((value) => value.attempts === 1 && value.externalId && !value.errorCode)).toBe(true);
  const privateTikTok = done.deliveries.find((value) => value.destinationId === available.find((row) => row.kind === "TIKTOK_PROFILE")!.id)!;
  expect(privateTikTok.publishUrl).toBeNull();
  await page.getByRole("button", { name: "Refresh delivery status", exact: true }).click();
  await expect(page.getByText("Published", { exact: true })).toHaveCount(7);
  const links = done.deliveries.filter((value) => value.publishUrl);
  await expect(page.getByRole("link", { name: "Open published post", exact: true })).toHaveCount(links.length);
  expect(links.length).toBeGreaterThan(0);
  const hrefs = await page.getByRole("link", { name: "Open published post", exact: true }).evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href")));
  expect(hrefs.sort()).toEqual(links.map((value) => value.publishUrl!).sort());
  // Verify receipts through each provider fixture's real HTTP counter endpoint.
  const counts = async () => Object.fromEntries(await Promise.all(Object.entries(fixture.providerOrigins).map(async ([provider, origin]) => {
    const response = await page.request.get(`${origin}/qa/counts`); expect(response.status()).toBe(200); return [provider, await response.json()];
  })));
  expect(await counts()).toEqual(expectedCounts);
  await expect(page.getByRole("button", { name: "Retry selected safe failures", exact: true })).toBeDisabled();
  await noHorizontalOverflow(page);
  await page.getByRole("heading", { name: "Delivery details", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("all-social-published-mobile.png") });
  await page.getByRole("heading", { name: "Delivery details", exact: true }).locator("..").screenshot({ path: info.outputPath("all-social-delivery-details-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await noHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath("all-social-published-desktop.png") });
  await page.getByRole("heading", { name: "Delivery details", exact: true }).locator("..").screenshot({ path: info.outputPath("all-social-delivery-details-desktop.png") });

  // A separate reviewed future post exercises lifecycle controls without
  // causing another provider submission or reusing static publication IDs.
  await page.goto("/social/create");
  const x = available.find((value) => value.kind === "X_PROFILE")!;
  await page.getByLabel(/^Draft title/).fill("Future X delivery lifecycle");
  await page.getByLabel("Caption or post text", { exact: true }).fill("Future reviewed post stays unsent.");
  await page.getByRole("checkbox", { name: new RegExp(`^${escaped(x.name!)}(?:\\s|$)`) }).check();
  await page.getByLabel("Maximum X publishing API cost (USD)", { exact: true }).fill("1");
  await page.getByLabel("This X post was made with AI", { exact: true }).selectOption("no");
  await page.getByLabel("This X post is a paid partnership", { exact: true }).selectOption("no");
  const futureSaved = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/social/posts" && response.request().method() === "POST");
  await page.getByRole("button", { name: "Save and review", exact: true }).click();
  const futureResponse = await futureSaved; expect(futureResponse.status()).toBe(201); const future: SocialPost = await futureResponse.json();
  expect(future.id).not.toBe(reviewed.id); await approveWithKeyboard(page, future.id);
  await page.getByLabel("Delivery timing", { exact: true }).selectOption("schedule");
  await page.getByLabel(/^IANA time zone/).fill("UTC");
  const later = futureUtcInput(2); await page.getByLabel(/^Publication date and time/).fill(later);
  const scheduleResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/social/posts/${future.id}/enqueue`);
  await page.getByRole("button", { name: "Confirm and schedule", exact: true }).click();
  const scheduled = await scheduleResponse; expect(scheduled.status()).toBe(200); const scheduledPost: SocialPost = await scheduled.json();
  expect(scheduledPost.deliveries).toHaveLength(1); expect(scheduledPost.deliveries[0]).toMatchObject({ status: "QUEUED", attempts: 0, dueAt: `${later}:00.000Z`, timeZone: "UTC" });
  const selectedDelivery = page.getByRole("checkbox", { name: /^Select delivery for / }); await selectedDelivery.check();
  await page.getByRole("button", { name: "Reschedule selected", exact: true }).click();
  const rescheduleTime = futureUtcInput(3);
  await page.getByLabel(/^IANA time zone/).last().fill("UTC"); await page.getByLabel(/^Publication date and time/).last().fill(rescheduleTime);
  const movedResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/social/posts/${future.id}/reschedule`);
  await page.getByRole("button", { name: "Confirm new delivery time", exact: true }).click();
  const moved = await movedResponse; expect(moved.status()).toBe(200);
  expect((await moved.json()).deliveries[0]).toMatchObject({ status: "QUEUED", attempts: 0, dueAt: `${rescheduleTime}:00.000Z` });
  await selectedDelivery.check(); await page.getByRole("button", { name: "Cancel selected deliveries", exact: true }).click();
  const cancelledResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/social/posts/${future.id}/cancel`);
  await page.getByRole("button", { name: "Confirm cancellation", exact: true }).click();
  expect((await cancelledResponse).status()).toBe(200);
  expect((await post(page, future.id)).deliveries[0]).toMatchObject({ status: "CANCELLED", attempts: 0, externalId: null });
  expect(await counts()).toEqual(expectedCounts); expect(advertisingWrites).toEqual([]);
  await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();
  await page.getByRole("heading", { name: "Delivery details", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("all-social-future-cancelled-desktop.png") });
});
