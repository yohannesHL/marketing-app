import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Generate real media on the test host: no committed binary, forged metadata,
// provider response interception or publication job is needed for this journey.
test("TikTok verifies its creator, requires explicit controls and preserves a dirty draft through fresh settings", async ({ page }, info) => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), "launchpad-tiktok-browser-"));
  const filename = `tiktok-${info.project.name}.mp4`, path = join(directory, filename);
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000", "-t", "3", "-c:v", "libx264", "-preset", "ultrafast",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", "-y", path],
      { timeout: 30_000, stdio: "pipe" });
    const enqueueRequests: string[] = [];
    page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/enqueue")) enqueueRequests.push(request.url()); });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/sign-in?returnTo=%2Fconnections");
    await page.getByLabel(/^Email/).fill(`tiktok-${info.project.name}@example.test`);
    await page.getByLabel(/^Password/).fill("isolated-test-password-for-fixtures");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/connections$/);
    const social = page.getByTestId("social-connections");
    // Select a real Mockoon private-account consent scenario. Continue the HTTP
    // authorization request; do not fulfill or replace callback/provider JSON.
    await page.route((url) => url.pathname === "/v2/auth/authorize/", async (route) => {
      const target = new URL(route.request().url()); expect(target.protocol).toBe("http:");
      expect(["127.0.0.1", "localhost", "[::1]"]).toContain(target.hostname);
      target.searchParams.set("fixture_consent", "private"); await route.continue({ url: target.href });
    });
    const callback = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/connections/tiktok/callback");
    await social.getByRole("button", { name: "Connect TikTok", exact: true }).click();
    expect((await callback).status()).toBe(303);
    await expect(page).toHaveURL(/\/connections\?provider=tiktok&result=connected/);
    const card = social.getByTestId("provider-connection"); await expect(card).toHaveCount(1);
    await card.getByRole("button", { name: "Select account", exact: true }).click();
    await expect(card.getByRole("button", { name: "Deselect account", exact: true })).toBeVisible();
    const rows = await (await page.request.get("/api/connections")).json(); expect(rows).toHaveLength(1);
    const connection = rows[0], destination = connection.destinations[0], creator = destination.metadata.tiktokCreator;
    expect(connection).toMatchObject({ provider: "TIKTOK", capability: "SOCIAL", connectionMode: "MOCK" });
    expect(destination).toMatchObject({ kind: "TIKTOK_PROFILE", externalId: "open-id-a", selected: true });
    expect(creator).toMatchObject({ openId: destination.externalId, authorizationId: connection.id, authorizationGeneration: 1,
      username: "fixture_creator", nickname: "Fixture TikTok creator", duetDisabled: true, stitchDisabled: true, maxDurationSeconds: 300 });
    expect(creator.privacyLevels).not.toContain("PUBLIC_TO_EVERYONE"); expect(creator.version).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(rows)).not.toMatch(/tt-access|tt-private|tt-refresh|Ciphertext|accessToken|fixture-tt-secret/);
    await expect(page.getByTestId("paid-connections").getByTestId("provider-connection")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("tiktok-connections-mobile.png"), fullPage: true });
    await page.goto("/social/create");
    await page.getByLabel(/^Draft title/).fill("Reviewed TikTok draft");
    await page.getByLabel("Caption or post text", { exact: true }).fill("Original TikTok caption.");
    await page.getByRole("checkbox", { name: /^Fixture TikTok creator\b/ }).check();
    await expect(page.getByRole("heading", { name: "Fixture TikTok creator · @fixture_creator", exact: true })).toBeVisible();
    await expect(page.getByText("Creator settings checked", { exact: false })).toBeVisible();
    const privacy = page.getByLabel("TikTok privacy", { exact: true }); await expect(privacy).toHaveValue("");
    await expect(privacy.locator("option")).toHaveText(["Choose privacy explicitly", "Only me"]);
    await expect(page.getByLabel("Allow TikTok Duet", { exact: true })).toBeDisabled();
    await expect(page.getByLabel("Allow TikTok Duet", { exact: true })).toHaveValue("no");
    await expect(page.getByLabel("Allow TikTok Stitch", { exact: true })).toBeDisabled();
    await expect(page.getByLabel("Allow TikTok Stitch", { exact: true })).toHaveValue("no");
    const comments = page.getByLabel("Allow TikTok comments", { exact: true }); await expect(comments).toHaveValue("");
    const commercial = page.getByLabel("Does this TikTok post promote a brand, product, or service?", { exact: true }); await expect(commercial).toHaveValue("");
    const ai = page.getByLabel("This TikTok video includes AI-generated content", { exact: true }); await expect(ai).toHaveValue("");
    const policy = page.getByRole("checkbox", { name: /^I agree to TikTok's Music Usage Confirmation/ }); await expect(policy).not.toBeChecked();
    const consent = page.getByRole("checkbox", { name: /^I approve posting this exact video and caption to @fixture_creator\b/ });
    await expect(consent).not.toBeChecked(); await expect(consent).toBeDisabled();
    const upload = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/social/media" && response.request().method() === "POST");
    await page.getByLabel("Upload image or video", { exact: true }).setInputFiles(path);
    const uploadResponse = await upload; expect(uploadResponse.status()).toBe(201); const media = await uploadResponse.json();
    expect(media).toMatchObject({ type: "VIDEO", mime: "video/mp4", width: 360, height: 640 });
    expect(media.durationMs).toBeGreaterThanOrEqual(2900); expect(media.durationMs).toBeLessThanOrEqual(3200);
    const attachment = page.getByRole("group", { name: "Attachments for Fixture TikTok creator", exact: true }).getByRole("checkbox", { name: filename, exact: true });
    await attachment.check();
    const chooseControls = async () => { await privacy.selectOption("SELF_ONLY"); await comments.selectOption("no"); await commercial.selectOption("no"); await policy.check(); await ai.selectOption("no"); };
    await chooseControls(); await expect(consent).toBeEnabled(); await consent.check();
    const caption = page.getByLabel("Caption for Fixture TikTok creator", { exact: true });
    await caption.fill("Unsaved caption stays through creator refresh."); await expect(consent).not.toBeChecked();
    await consent.check(); await expect(consent).toBeChecked();
    const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/connections/tiktok/${connection.id}/check` && response.request().method() === "POST");
    await page.getByRole("button", { name: "Refresh TikTok creator settings", exact: true }).click();
    const refreshResponse = await refreshed; expect(refreshResponse.status()).toBe(200);
    expect(refreshResponse.request().postDataJSON()).toEqual({ destinationId: destination.id });
    const freshConnection = (await refreshResponse.json()).connection, freshCreator = freshConnection.destinations[0].metadata.tiktokCreator;
    await expect(caption).toHaveValue("Unsaved caption stays through creator refresh.");
    await expect(page.getByLabel(/^Draft title/)).toHaveValue("Reviewed TikTok draft"); await expect(attachment).toBeChecked();
    await expect(consent).not.toBeChecked(); await expect(consent).toBeDisabled(); await expect(privacy).toHaveValue("");
    await expect(policy).not.toBeChecked(); await expect(comments).toHaveValue(""); await expect(ai).toHaveValue("");
    expect(freshCreator.authorizationId).toBe(connection.id); expect(freshCreator.version).toMatch(/^[a-f0-9]{64}$/);
    await chooseControls(); await consent.check();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("tiktok-review-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("tiktok-review-desktop.png"), fullPage: true });
    const saved = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/social/posts" && response.request().method() === "POST");
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    const saveResponse = await saved; expect(saveResponse.status()).toBe(201); const post = await saveResponse.json();
    expect(post.publishingEnabled).toBe(false); expect(post.deliveries).toEqual([]); expect(enqueueRequests).toEqual([]);
    expect(post.revision.variants[0]).toMatchObject({ destinationId: destination.id, format: "SHORT_VIDEO", body: "Unsaved caption stays through creator refresh.", mediaIds: [media.id],
      providerOptions: { privacyLevel: "SELF_ONLY", disableComment: true, disableDuet: true, disableStitch: true, commercialContentDisclosure: false,
        brandContentToggle: false, brandOrganicToggle: false, musicUsageConsent: true, isAigc: false, explicitPostingConsent: true, creatorInfoVersion: freshCreator.version } });
    const persistedResponse = await page.request.get(`/api/social/posts/${post.id}`); expect(persistedResponse.status()).toBe(200);
    const persisted = await persistedResponse.json(); expect(persisted.revision.id).toBe(post.revision.id); expect(persisted.deliveries).toEqual([]);
    expect(JSON.stringify(persisted)).not.toMatch(/tt-private|tt-refresh|Ciphertext|accessToken|fixture-tt-secret|storageKey|signature=/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
