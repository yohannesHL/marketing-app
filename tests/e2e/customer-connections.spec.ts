import { expect, test, type Locator, type Page } from "@playwright/test";

type PublicConnection = {
  id: string; provider: string; capability: string; status: string; connectionMode: string;
  credentialVersion: number;
  destinations: { id: string; externalId: string; selected: boolean; selectedContext: { loginCustomerId: string | null } | null }[];
};

async function connections(page: Page) {
  const response = await page.request.get("/api/connections");
  expect(response.ok()).toBeTruthy();
  const rows = await response.json() as PublicConnection[];
  expect(JSON.stringify(rows)).not.toMatch(/mock-access|mock-refresh|long_success|Ciphertext|accessToken|refreshToken/);
  return rows;
}
function account(page: Page, name: string) {
  return page.getByTestId("connection-destination").filter({ has: page.getByRole("heading", { name, exact: true }) });
}
function grantCard(page: Page, name: string) {
  return page.getByTestId("provider-connection").filter({ has: page.getByRole("heading", { name, exact: true }) });
}
async function connect(page: Page, provider: "google" | "meta", button: Locator) {
  const started = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/connections/${provider}/start`);
  const consent = page.waitForRequest((request) => new URL(request.url()).pathname === (provider === "google" ? "/o/oauth2/v2/auth" : "/v26.0/dialog/oauth"));
  const callback = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/connections/${provider}/callback`);
  await button.click();
  const response = await started;
  expect(response.status()).toBe(200);
  const consentUrl = new URL((await consent).url());
  expect(consentUrl.protocol).toBe("http:");
  expect(["127.0.0.1", "localhost", "[::1]"]).toContain(consentUrl.hostname);
  expect((await callback).status()).toBe(303);
  await expect(page).toHaveURL(new RegExp(`/connections\\?provider=${provider}&result=connected`));
  await expect(grantCard(page, provider === "google" ? "Google Ads" : "Meta Ads")).toContainText("Mockoon test connection");
}
async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test("customer signs in with a keyboard and manages isolated advertising permissions on mobile", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const email = `connections-${testInfo.project.name}@example.test`;
  const password = "isolated-test-password-for-fixtures";
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 375, height: 812 });

  await test.step("keyboard sign-in supports password managers, retains errors, and rejects an external return destination", async () => {
    await page.goto("/sign-in?returnTo=https%3A%2F%2Fattacker.example%2F");
    await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
    await expect(page.getByLabel(/^Email/)).toHaveAttribute("autocomplete", "username");
    await expect(page.getByLabel(/^Password/)).toHaveAttribute("autocomplete", "current-password");
    await noHorizontalOverflow(page);
    await page.getByLabel(/^Email/).fill(email);
    await page.getByLabel(/^Password/).fill("incorrect-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByTestId("sign-in-page").getByRole("alert")).toContainText("Email or password is incorrect");
    await expect(page.getByLabel(/^Email/)).toHaveValue(email);
    await page.getByLabel(/^Email/).focus();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel(/^Password/)).toBeFocused();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText(password);
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeFocused();
    let releaseLoading!: () => void;
    const initialDiscovery = new Promise<void>((resolve) => { releaseLoading = resolve; });
    // Delay the real application request to observe loading; do not replace its response.
    await page.route("**/api/connections", async (route) => { await initialDiscovery; await route.continue(); }, { times: 1 });
    try {
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/connections$/);
      await expect(page.getByTestId("connections-page").getByRole("status")).toContainText("Loading your connections");
    } finally { releaseLoading(); }
    await expect(page.getByTestId("connections-page")).toBeVisible();
    await expect(page.getByRole("note")).toContainText("Mockoon test mode");
    const previous = await connections(page);
    // Isolated fixtures may retain a previous interrupted test's grant. Normalize
    // through the same customer-owned public disconnect endpoint before this run.
    for (const row of previous.filter((connection) => connection.capability === "ADS" && connection.status !== "DISCONNECTED")) {
      expect(row.connectionMode).toBe("MOCK");
      const removed = await page.request.delete(`/api/connections/${encodeURIComponent(row.id)}`, { headers: { Origin: new URL(page.url()).origin } });
      expect(removed.ok()).toBeTruthy();
    }
    if (previous.length) await page.reload();
    await expect(page.getByRole("button", { name: "Connect Google Ads", exact: true })).toBeEnabled();
    if (!(await connections(page)).some((row) => row.destinations.some((destination) => destination.selected))) await expect(page.getByRole("button", { name: "Check selected accounts", exact: true })).toBeDisabled();
    if (!(await connections(page)).length) await expect(page.getByTestId("paid-connections")).toContainText("No advertising permissions connected yet");
  });

  await test.step("Google consent discovers paginated accounts with explicit direct and manager access", async () => {
    await connect(page, "google", page.getByRole("button", { name: "Connect Google Ads", exact: true }));
    const advertiser = account(page, "Advertiser 400");
    await expect(advertiser).toHaveCount(1);
    await expect(advertiser).toContainText("GBP");
    await expect(advertiser).toContainText("Europe/London");
    await expect(advertiser).toContainText("Not verified");
    await expect(advertiser.getByRole("button", { name: "Select account", exact: true })).toBeDisabled();
    await expect(account(page, "Manager 100").getByRole("button", { name: "Select account" })).toHaveCount(0);
    const accessPath = advertiser.getByRole("combobox");
    await expect(accessPath).toHaveValue("");
    await expect(accessPath.locator("option")).toContainText(["Choose an access path", "Via manager 100", "Via manager 200"]);
    await accessPath.selectOption("100");
    await advertiser.getByRole("button", { name: "Select account", exact: true }).click();
    await expect(advertiser).toContainText("Selected access: manager 100");
    let google = (await connections(page)).find((row) => row.provider === "GOOGLE" && row.capability === "ADS")!;
    expect(google.connectionMode).toBe("MOCK");
    expect(google.destinations.find((row) => row.externalId === "400")).toMatchObject({ selected: true, selectedContext: { loginCustomerId: "100" } });
    await accessPath.selectOption("200");
    await advertiser.getByRole("button", { name: "Save access path", exact: true }).click();
    await expect(advertiser).toContainText("Selected access: manager 200");
    const direct = account(page, "Advertiser 300");
    await direct.getByRole("combobox").selectOption("direct");
    await direct.getByRole("button", { name: "Select account", exact: true }).click();
    await expect(direct).toContainText("Selected access: direct");
    google = (await connections(page)).find((row) => row.provider === "GOOGLE" && row.capability === "ADS")!;
    expect(google.destinations.find((row) => row.externalId === "300")).toMatchObject({ selected: true, selectedContext: { loginCustomerId: null } });
    await noHorizontalOverflow(page);
    const mobileScreenshot = testInfo.outputPath("mobile-connections.png");
    await page.screenshot({ path: mobileScreenshot, fullPage: true });
    await testInfo.attach("mobile-connections-google", { path: mobileScreenshot, contentType: "image/png" });
    const accessScreenshot = testInfo.outputPath("mobile-google-access-path.png");
    await advertiser.screenshot({ path: accessScreenshot });
    await testInfo.attach("mobile-google-access-path", { path: accessScreenshot, contentType: "image/png" });
  });

  await test.step("read checks and rediscovery preserve account selection and reconnect the same grant", async () => {
    const googleBefore = (await connections(page)).find((row) => row.provider === "GOOGLE" && row.capability === "ADS")!;
    await account(page, "Advertiser 400").getByRole("button", { name: "Check read access", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Read access checked");
    const card = grantCard(page, "Google Ads");
    await card.getByRole("button", { name: "Refresh accounts", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Accounts refreshed");
    await expect(account(page, "Advertiser 400")).toContainText("Selected access: manager 200");
    await connect(page, "google", card.getByRole("button", { name: "Reconnect Google Ads", exact: true }));
    const googleAfter = (await connections(page)).find((row) => row.provider === "GOOGLE" && row.capability === "ADS")!;
    expect(googleAfter.id).toBe(googleBefore.id);
    expect(googleAfter.credentialVersion).toBeGreaterThan(googleBefore.credentialVersion);
    await account(page, "Advertiser 300").getByRole("button", { name: "Deselect account", exact: true }).click();
    await expect(account(page, "Advertiser 300").getByRole("button", { name: "Select account", exact: true })).toBeVisible();
  });

  await test.step("Meta advertising permissions never authorize social publishing or a read-only account", async () => {
    await connect(page, "meta", page.getByRole("button", { name: "Connect Meta Ads", exact: true }));
    await expect(account(page, "Account 222").getByRole("button", { name: "Select account", exact: true })).toBeDisabled();
    await expect(account(page, "Account 222")).toContainText("Denied");
    await expect(account(page, "Account 333")).toContainText("Unavailable");
    await account(page, "Account 111").getByRole("button", { name: "Select account", exact: true }).click();
    await expect(account(page, "Account 111").getByRole("button", { name: "Deselect account", exact: true })).toBeVisible();
    const social = page.getByTestId("social-connections");
    await expect(social).toContainText("No social publishing permissions connected yet");
    for (const label of ["Facebook Pages", "Instagram", "YouTube Shorts", "TikTok", "LinkedIn", "X"]) await expect(social.getByText(label, { exact: true })).toBeVisible();
    await expect(social.getByRole("button", { name: "Connect YouTube Shorts", exact: true })).toBeEnabled();
    await expect(social.getByRole("button", { name: "Connect Facebook Pages", exact: true })).toBeEnabled();
    await expect(social.getByRole("button", { name: "Connect Instagram", exact: true })).toBeEnabled();
    await expect(social.getByRole("button", { name: "Connect TikTok", exact: true })).toBeEnabled();
    await expect(social.getByRole("button")).toHaveCount(5);
    await expect(social.getByTestId("provider-connection")).toHaveCount(0);
    const selectedIds = (await connections(page)).filter((row) => row.capability === "ADS")
      .flatMap((row) => row.destinations.filter((destination) => destination.selected).map((destination) => destination.id)).sort();
    const readinessRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/ads/readiness" && request.method() === "POST");
    const readinessResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/ads/readiness" && response.request().method() === "POST");
    await page.getByRole("button", { name: "Check selected accounts", exact: true }).click();
    expect((await readinessRequest).postDataJSON().destinationIds.sort()).toEqual(selectedIds);
    const result = await readinessResponse;
    expect(result.status()).toBe(200);
    const readiness = await result.json();
    expect(readiness).toMatchObject({ mode: "mock", writesEnabled: false, success: true, partial: false });
    expect(readiness.outcomes.map((outcome: { destinationId: string }) => outcome.destinationId).sort()).toEqual(selectedIds);
    expect(readiness.outcomes.every((outcome: { success: boolean; canRead: boolean; canWrite: string }) => outcome.success && outcome.canRead && outcome.canWrite === "DISABLED")).toBe(true);
    await expect(page.getByTestId("selected-account-readiness")).toContainText("Selected accounts can be read");
    await expect(page.getByTestId("selected-account-readiness")).toContainText("Live campaign writes remain disabled");
    await expect(page.getByTestId("selected-account-readiness")).toContainText("Google Ads");
    await expect(page.getByTestId("selected-account-readiness")).toContainText("Meta Ads");
    expect((await connections(page)).every((row) => row.capability === "ADS")).toBe(true);
    await noHorizontalOverflow(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await noHorizontalOverflow(page);
    const desktopScreenshot = testInfo.outputPath("desktop-connections.png");
    await page.screenshot({ path: desktopScreenshot, fullPage: true });
    await testInfo.attach("desktop-connections", { path: desktopScreenshot, contentType: "image/png" });
    const readinessScreenshot = testInfo.outputPath("selected-account-readiness.png");
    await page.getByTestId("selected-account-readiness").screenshot({ path: readinessScreenshot });
    await testInfo.attach("selected-account-readiness", { path: readinessScreenshot, contentType: "image/png" });
    await page.setViewportSize({ width: 812, height: 375 });
    await noHorizontalOverflow(page);
  });

  await test.step("a real Mockoon consent denial leaves the current authorization unchanged", async () => {
    const before = (await connections(page)).find((row) => row.provider === "GOOGLE" && row.capability === "ADS")!;
    const fixtureConsent = /http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/o\/oauth2\/v2\/auth/;
    await page.route(fixtureConsent, async (route) => {
      const url = new URL(route.request().url());
      // Select a real local Mockoon response; no provider response is fulfilled by Playwright.
      url.searchParams.set("fixture_consent", "denied");
      await route.continue({ url: url.href });
    });
    try {
      const callback = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/connections/google/callback");
      await grantCard(page, "Google Ads").getByRole("button", { name: "Reconnect Google Ads", exact: true }).click();
      expect((await callback).status()).toBe(303);
      await expect(page).toHaveURL(/\/connections\?provider=google&result=failed/);
      await expect(page.getByTestId("connections-page").getByRole("alert")).toContainText("Permission was declined");
      const after = (await connections(page)).find((row) => row.id === before.id)!;
      expect(after.status).toBe("CONNECTED");
      expect(after.credentialVersion).toBe(before.credentialVersion);
    } finally { await page.unroute(fixtureConsent); }
  });

  await test.step("callback errors are helpful and never render raw provider payloads", async () => {
    await page.goto("/connections?provider=google&result=failed&error=RECONNECT_REQUIRED");
    await expect(page.getByTestId("connections-page").getByRole("alert")).toContainText("This authorization has expired or was revoked");
    await expect(grantCard(page, "Google Ads")).toBeVisible();
    await page.goto("/connections?provider=google&result=failed&error=%3Cscript%3Eprovider-secret%3C%2Fscript%3E");
    await expect(page.getByTestId("connections-page").getByRole("alert")).toContainText("The request could not be completed");
    await expect(page.getByTestId("connections-page")).not.toContainText("provider-secret");
    expect(await page.evaluate(() => JSON.stringify(Object.entries(localStorage)))).not.toMatch(/mock-access|mock-refresh|long_success/);
    await page.goto("/connections");
    await expect(grantCard(page, "Google Ads")).toBeVisible();
  });

  await test.step("disconnect requires an inline confirmation, deselects accounts, and sign-out ends access", async () => {
    const card = grantCard(page, "Google Ads");
    await card.getByRole("button", { name: "Disconnect Google Ads", exact: true }).click();
    await expect(card).toContainText("stops queued work");
    await card.getByRole("button", { name: "Keep connection", exact: true }).click();
    await expect(card.getByRole("button", { name: "Disconnect Google Ads", exact: true })).toBeFocused();
    await card.getByRole("button", { name: "Disconnect Google Ads", exact: true }).click();
    await card.getByRole("button", { name: "Confirm disconnect", exact: true }).click();
    await expect(card).toContainText("Disconnected");
    const google = (await connections(page)).find((row) => row.provider === "GOOGLE" && row.capability === "ADS")!;
    expect(google.status).toBe("DISCONNECTED");
    expect(google.destinations.every((row) => !row.selected)).toBe(true);
    await expect(card.getByRole("button", { name: "Refresh accounts", exact: true })).toBeDisabled();
    await expect(grantCard(page, "Meta Ads")).toContainText("Connected");
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    expect((await page.request.get("/api/auth/session")).status()).toBe(401);
    await page.goto("/connections");
    await expect(page).toHaveURL(/\/sign-in\?returnTo=%2Fconnections$/);
    expect(errors).toEqual([]);
  });
});
