import { expect, test, type Page } from "@playwright/test";
import { deflateSync } from "node:zlib";
import { scheduleInstants } from "../../apps/web/src/components/social/socialTime";
import { safeReturnTo } from "../../apps/web/src/components/connections/connectionUi";
import type { SocialPost } from "../../apps/web/src/components/social/socialUi";

function fixtureImage() {
  const crc = (bytes: Buffer) => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let i = 0; i < 8; i++)
        value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (name: string, body: Buffer) => {
    const type = Buffer.from(name),
      length = Buffer.alloc(4),
      checksum = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    checksum.writeUInt32BE(crc(Buffer.concat([type, body])));
    return Buffer.concat([length, type, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(320, 0);
  header.writeUInt32BE(320, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(320 * (1 + 320 * 3));
  for (let y = 0; y < 320; y++)
    for (let x = 0; x < 320; x++) {
      const i = y * (1 + 320 * 3) + 1 + x * 3;
      pixels[i] = 116;
      pixels[i + 1] = 73;
      pixels[i + 2] = 220;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
async function readPost(page: Page, id: string) {
  const response = await page.request.get(`/api/social/posts/${id}`);
  expect(response.ok()).toBe(true);
  const post = (await response.json()) as SocialPost;
  expect(JSON.stringify(post)).not.toMatch(
    /Ciphertext|storageKey|mock-access|mock-refresh|accessToken|refreshToken/,
  );
  return post;
}
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}

test("creating another social post starts a separate empty draft", async ({ page }, testInfo) => {
  await page.goto("/sign-in?returnTo=%2Fsocial%2Fcreate");
  await page.getByLabel(/^Email/).fill(`social-${testInfo.project.name}@example.test`);
  await page.getByLabel(/^Password/).fill("isolated-test-password-for-fixtures");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/social\/create$/);
  await page.getByLabel(/^Draft title/).fill("First independent draft");
  await page.getByLabel("Caption or post text", { exact: true }).fill("Keep this saved caption.");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page).toHaveURL(/\/social\/posts\/[A-Za-z0-9_-]+$/);
  const first = new URL(page.url()).pathname.split("/").at(-1)!;
  const original = await readPost(page, first);
  await page.getByRole("link", { name: "Create social post", exact: true }).click();
  await expect(page).toHaveURL(/\/social\/create$/);
  await expect(page.getByRole("heading", { name: "Create social post", exact: true })).toBeVisible();
  await expect(page.getByLabel(/^Draft title/)).toHaveValue("");
  await expect(page.getByLabel("Caption or post text", { exact: true })).toHaveValue("");
  await page.getByLabel(/^Draft title/).fill("Second independent draft");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page).toHaveURL(/\/social\/posts\/[A-Za-z0-9_-]+$/);
  expect(new URL(page.url()).pathname.split("/").at(-1)).not.toBe(first);
  expect((await readPost(page, first)).revision.id).toBe(original.revision.id);
  expect((await readPost(page, first)).revision.body).toBe("Keep this saved caption.");
});

test("a refreshed content revision requires a fresh review acknowledgment", async ({ page }, testInfo) => {
  await page.goto("/sign-in?returnTo=%2Fsocial%2Fcreate");
  await page.getByLabel(/^Email/).fill(`social-${testInfo.project.name}@example.test`);
  await page.getByLabel(/^Password/).fill("isolated-test-password-for-fixtures");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/social\/create$/);
  await page.getByLabel(/^Draft title/).fill("Review revision fixture");
  await page.getByLabel("Caption or post text", { exact: true }).fill("Original reviewed caption.");
  await page.getByRole("checkbox", { name: /^Fixture LinkedIn member/ }).check();
  await page.getByRole("button", { name: "Save and review", exact: true }).click();
  await expect(page).toHaveURL(/\/social\/posts\/[A-Za-z0-9_-]+$/);
  const id = new URL(page.url()).pathname.split("/").at(-1)!;
  // A read-only cancelled delivery fixture exposes the status-refresh UI.
  // Content revisions and approvals still use the real authenticated API.
  await page.route((url) => [ `/api/social/posts/${id}`, `/api/social/posts/${id}/approve` ].includes(url.pathname), async (route) => {
    if (route.request().method() !== "GET" && !route.request().url().endsWith("/approve")) return route.continue();
    const response = await route.fetch();
    const value = await response.json();
    value.deliveries = [{ id: "review_refresh_fixture", revisionId: value.revision.id,
      destinationId: value.revision.variants[0].destinationId, status: "CANCELLED", phase: "PREPARE",
      dueAt: "2026-10-13T12:00:00Z", timeZone: "UTC", attempts: 0, cancellationRequested: true }];
    await route.fulfill({ response, json: value });
  });
  await page.reload();
  await page.getByRole("button", { name: "Save and review", exact: true }).click();
  await page.getByRole("checkbox", { name: "I reviewed revision 1 and every destination variant", exact: true }).check();
  await page.getByRole("button", { name: "Approve saved revision", exact: true }).click();
  await expect(page.getByRole("button", { name: "Revision reviewed", exact: true })).toBeDisabled();
  const saved = await readPost(page, id);
  const response = await page.request.patch(`/api/social/posts/${id}`, {
    headers: { Origin: new URL(page.url()).origin }, data: {
      revisionId: saved.revision.id, title: saved.title, body: "Changed in another tab.", mediaIds: [],
      variants: saved.revision.variants.map((variant) => ({ destinationId: variant.destinationId,
        format: variant.format, body: "Changed in another tab.", mediaIds: [], providerOptions: variant.providerOptions })),
    },
  });
  expect(response.ok()).toBe(true);
  await page.getByRole("button", { name: "Refresh delivery status", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "I reviewed revision 2 and every destination variant", exact: true })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Approve saved revision", exact: true })).toBeDisabled();
});

test("scheduling resolves daylight-saving gaps, repeated times, and half-hour zones", () => {
  expect(scheduleInstants("2026-03-29T01:30", "Europe/London")).toEqual([]);
  expect(scheduleInstants("2026-10-25T01:30", "Europe/London")).toEqual([
    "2026-10-25T00:30:00.000Z",
    "2026-10-25T01:30:00.000Z",
  ]);
  expect(scheduleInstants("2026-10-13T10:00", "Asia/Kathmandu")).toEqual([
    "2026-10-13T04:15:00.000Z",
  ]);
  expect(scheduleInstants("2026-04-05T01:45", "Australia/Lord_Howe")).toEqual([
    "2026-04-04T14:45:00.000Z",
    "2026-04-04T15:15:00.000Z",
  ]);
  expect(scheduleInstants("2026-02-31T12:00", "UTC")).toEqual([]);
});
test("social sign-in return routes reject external, query, fragment, and separator destinations", () => {
  for (const path of ["/social", "/social/create", "/social/posts/owned_123"]) {
    expect(safeReturnTo(path)).toBe(path);
  }
  for (const path of [
    "//evil.example",
    "/social?redirect=evil",
    "/social/posts/a#fragment",
    "/social/posts/a?x=1",
    "/social/posts/a/b",
    "/social/posts/\\evil",
    "https://evil.example",
  ]) {
    expect(safeReturnTo(path)).toBe("/connections");
  }
});

test("customer saves and reviews social revisions without pretending disabled publishing succeeded", async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  const enqueueRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/enqueue"))
      enqueueRequests.push(request.url());
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/sign-in?returnTo=%2Fsocial%2Fcreate");
  await page
    .getByLabel(/^Email/)
    .fill(`social-${testInfo.project.name}@example.test`);
  await page
    .getByLabel(/^Password/)
    .fill("isolated-test-password-for-fixtures");
  await page.getByLabel(/^Password/).focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/social\/create$/);
  await expect(
    page.getByRole("heading", { name: "Create social post", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Mockoon test mode", { exact: true }),
  ).toBeVisible();
  await noOverflow(page);
  for (const platform of [
    "YouTube Shorts",
    "Facebook Pages",
    "Instagram",
    "TikTok",
    "LinkedIn",
    "X",
  ]) {
    await expect(
      page.getByRole("heading", { name: platform, exact: true }),
    ).toBeVisible();
  }
  await page
    .getByLabel(/^Draft title/)
    .fill(`Social draft ${testInfo.project.name}`);
  await page
    .getByLabel("Caption or post text", { exact: true })
    .fill("Customer-owned launch update.");
  await page
    .getByRole("checkbox", { name: /^Fixture LinkedIn member/ })
    .check();
  await page
    .getByLabel("LinkedIn visibility", { exact: true })
    .selectOption("PUBLIC");
  await page
    .getByLabel("Upload image or video", { exact: true })
    .setInputFiles({
      name: "fixture-image.png",
      mimeType: "image/png",
      buffer: fixtureImage(),
    });
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Media uploaded and inspected" }),
  ).toBeVisible();
  const imagePreview = page
    .getByRole("img", { name: "fixture-image.png", exact: true })
    .first();
  await expect(imagePreview).toBeVisible();
  await expect
    .poll(() =>
      imagePreview.evaluate(
        (image) => (image as HTMLImageElement).naturalWidth,
      ),
    )
    .toBe(320);
  const captionBox = await imagePreview
    .locator("..")
    .locator("figcaption")
    .boundingBox();
  expect(captionBox?.width).toBeGreaterThan(100);
  expect(captionBox?.height).toBeLessThan(80);
  await page
    .getByLabel("Format for Fixture LinkedIn member", { exact: true })
    .selectOption("IMAGE");
  await page
    .getByRole("button", { name: "Save and review", exact: true })
    .click();
  await expect(
    page.getByTestId("social-page").getByRole("alert"),
  ).toContainText(
    "This destination does not support the selected content format or media.",
  );
  const captionInput = page.getByLabel("Caption for Fixture LinkedIn member", {
    exact: true,
  });
  await captionInput.focus();
  await page.keyboard.type(" ");
  await expect(captionInput).toBeFocused();
  await page
    .getByRole("checkbox", { name: "fixture-image.png", exact: true })
    .check();
  await page
    .getByLabel("Caption for Fixture LinkedIn member", { exact: true })
    .fill("A member-specific caption.");
  await page
    .getByRole("button", { name: "Save and review", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Review social post", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/social\/posts\/[A-Za-z0-9_-]+$/);
  const id = new URL(page.url()).pathname.split("/").at(-1)!;
  let post = await readPost(page, id);
  expect(post.revision.media[0]).toMatchObject({
    width: 320,
    height: 320,
    type: "IMAGE",
    mime: "image/png",
  });
  expect(post.revision.variants[0]).toMatchObject({
    format: "IMAGE",
    body: "A member-specific caption.",
    providerOptions: { visibility: "PUBLIC" },
    publishingEnabled: false,
  });
  expect(post.deliveries).toEqual([]);
  const revisionOne = post.revision.id;
  await page
    .getByRole("checkbox", {
      name: "I reviewed revision 1 and every destination variant",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "Approve saved revision", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Revision reviewed", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Confirm and publish now", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("Delivery timing", { exact: true })
    .selectOption("schedule");
  await page
    .getByLabel("IANA time zone", { exact: true })
    .fill("Europe/London");
  await page
    .getByLabel("Publication date and time", { exact: true })
    .fill("2026-10-25T01:30");
  await page
    .getByLabel("Daylight-saving time choice", { exact: true })
    .selectOption("2026-10-25T01:30:00.000Z");
  await expect(
    page.getByText("2026-10-25 01:30:00 UTC", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirm and schedule", exact: true }),
  ).toBeDisabled();
  expect((await readPost(page, id)).deliveries).toEqual([]);
  expect(enqueueRequests).toEqual([]);
  await noOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("social-mobile-review.png"),
    fullPage: true,
  });
  await page
    .locator(".card")
    .filter({
      has: page.getByRole("heading", {
        name: "Review social post",
        exact: true,
      }),
    })
    .screenshot({
      path: testInfo.outputPath("social-mobile-review-panel.png"),
    });
  await page
    .getByLabel("Caption for Fixture LinkedIn member", { exact: true })
    .fill("Updated approved content requires a fresh review.");
  await page
    .getByRole("button", { name: "Save and review", exact: true })
    .click();
  await expect(
    page.getByRole("checkbox", {
      name: "I reviewed revision 2 and every destination variant",
      exact: true,
    }),
  ).not.toBeChecked();
  post = await readPost(page, id);
  expect(post.revision.approvedDestinations).toBeNull();
  expect(post.revision.reviewedAt).toBeNull();
  const stale = await page.request.patch(`/api/social/posts/${id}`, {
    headers: { Origin: new URL(page.url()).origin },
    data: {
      revisionId: revisionOne,
      title: post.title,
      body: post.revision.body,
      mediaIds: post.revision.media.map((m) => m.id),
      variants: [],
    },
  });
  expect(stale.status()).toBe(409);
  expect((await readPost(page, id)).currentRevision).toBe(2);
  await page
    .getByLabel("Draft title")
    .fill(`Preserved ${testInfo.project.name}`);
  const mainMenu = page.getByRole("button", { name: "Main menu", exact: true });
  if (await mainMenu.isVisible()) await mainMenu.click();
  await page
    .getByRole("navigation", { name: "Main navigation", exact: true })
    .getByRole("link", {
      name: "Campaigns",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/\/campaigns\/create$/);
  expect((await readPost(page, id)).title).toBe(
    `Preserved ${testInfo.project.name}`,
  );
  await page.goto(`/social/posts/${id}`);
  await expect(page.getByLabel(/^Draft title/)).toHaveValue(
    `Preserved ${testInfo.project.name}`,
  );
  await page
    .getByRole("link", { name: "Publishing calendar", exact: true })
    .click();
  await expect(page).toHaveURL(/\/social$/);
  await expect(
    page.getByRole("link", {
      name: `Preserved ${testInfo.project.name}`,
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Calendar", exact: true }).click();
  await expect(
    page.getByText("Unscheduled drafts", { exact: true }),
  ).toBeVisible();
  await noOverflow(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: testInfo.outputPath("social-desktop-calendar.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
