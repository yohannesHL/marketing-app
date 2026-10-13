import { expect, test } from "../support/fixtures";
import {
  openStorybookPreview,
  readComputedStyle,
  readNearestPaintedBackground,
} from "../support/helpers/storybook";
import { resolveStorybookBaseUrl } from "../support/helpers/env";

const storybookBaseUrl = resolveStorybookBaseUrl();

test.describe("Sprint 1 Story 1 - Storybook design-system foundation (ATDD)", () => {
  test.skip("[P0] Given Storybook manager when the foundation brand guide opens then theme and brand toolbar controls are available", async ({
    page,
  }) => {
    await page.goto(`${storybookBaseUrl}/?path=/story/foundation-brand-guide--overview`, {
      waitUntil: "domcontentloaded",
    });

    await expect(page.getByRole("button", { name: /theme/i })).toBeVisible();
    await page.getByRole("button", { name: /theme/i }).click();
    await expect(page.getByRole("menuitemradio", { name: /light/i })).toBeVisible();
    await expect(page.getByRole("menuitemradio", { name: /dark/i })).toBeVisible();
    await page.keyboard.press("Escape");

    await expect(page.getByRole("button", { name: /brand/i })).toBeVisible();
    await page.getByRole("button", { name: /brand/i }).click();
    await expect(page.getByRole("menuitemradio", { name: /launchpad/i })).toBeVisible();
    await expect(page.getByRole("menuitemradio", { name: /midnight/i })).toBeVisible();

    const previewFrame = page.frameLocator("#storybook-preview-iframe");
    await expect(
      previewFrame.getByRole("heading", {
        name: /modern startup polish with product-grade clarity/i,
      }),
    ).toBeVisible();
  });

  test.skip("[P0] Given the brand guide preview when the theme switches from light to dark then token-driven surfaces update consistently", async ({
    page,
  }) => {
    await openStorybookPreview(page, "foundation-brand-guide--overview", {
      theme: "light",
      brand: "launchpad",
    });

    const lightCanvas = page.locator("[data-theme]").first();
    const lightHeading = page.getByRole("heading", {
      name: /modern startup polish with product-grade clarity/i,
    });
    const lightCardHeading = page.getByRole("heading", { name: "Typography and emphasis" });

    await expect(lightCanvas).toHaveAttribute("data-theme", "launchpad-light");
    await expect(lightHeading).toBeVisible();
    await expect(lightCardHeading).toBeVisible();

    const lightCanvasStyles = await readComputedStyle(lightCanvas);
    const lightHeadingStyles = await readComputedStyle(lightHeading);
    const lightCardBackground = await readNearestPaintedBackground(lightCardHeading);

    await openStorybookPreview(page, "foundation-brand-guide--overview", {
      theme: "dark",
      brand: "launchpad",
    });

    const darkCanvas = page.locator("[data-theme]").first();
    const darkHeading = page.getByRole("heading", {
      name: /modern startup polish with product-grade clarity/i,
    });
    const darkCardHeading = page.getByRole("heading", { name: "Typography and emphasis" });

    await expect(darkCanvas).toHaveAttribute("data-theme", "launchpad-dark");
    await expect(darkHeading).toBeVisible();
    await expect(darkCardHeading).toBeVisible();

    const darkCanvasStyles = await readComputedStyle(darkCanvas);
    const darkHeadingStyles = await readComputedStyle(darkHeading);
    const darkCardBackground = await readNearestPaintedBackground(darkCardHeading);

    expect(lightCanvasStyles.backgroundColor).not.toBe(darkCanvasStyles.backgroundColor);
    expect(lightHeadingStyles.color).not.toBe(darkHeadingStyles.color);
    expect(lightCardBackground).not.toBeNull();
    expect(darkCardBackground).not.toBeNull();
    expect(lightCardBackground).not.toBe(darkCardBackground);
  });

  test.skip("[P0] Given the brand guide preview when the brand switches from launchpad to midnight then brand-driven values change without breaking semantic roles", async ({
    page,
  }) => {
    await openStorybookPreview(page, "foundation-brand-guide--overview", {
      theme: "light",
      brand: "launchpad",
    });

    const launchpadCanvas = page.locator("[data-theme]").first();
    const launchpadHeading = page.getByRole("heading", {
      name: /modern startup polish with product-grade clarity/i,
    });
    const launchpadLink = page.getByRole("link", { name: "Read the style guide" });

    await expect(launchpadCanvas).toHaveAttribute("data-theme", "launchpad-light");
    await expect(launchpadHeading).toBeVisible();
    await expect(launchpadLink).toBeVisible();

    const launchpadLinkStyles = await readComputedStyle(launchpadLink);
    const launchpadHeadingStyles = await readComputedStyle(launchpadHeading);

    await openStorybookPreview(page, "foundation-brand-guide--overview", {
      theme: "light",
      brand: "midnight",
    });

    const midnightCanvas = page.locator("[data-theme]").first();
    const midnightHeading = page.getByRole("heading", {
      name: /modern startup polish with product-grade clarity/i,
    });
    const midnightLink = page.getByRole("link", { name: "Read the style guide" });

    await expect(midnightCanvas).toHaveAttribute("data-theme", "midnight-light");
    await expect(midnightHeading).toBeVisible();
    await expect(midnightLink).toBeVisible();

    const midnightLinkStyles = await readComputedStyle(midnightLink);
    const midnightHeadingStyles = await readComputedStyle(midnightHeading);

    expect(launchpadLinkStyles.color).not.toBe(midnightLinkStyles.color);
    expect(launchpadHeadingStyles.fontSize).toBe(midnightHeadingStyles.fontSize);
  });

  test.skip("[P1] Given the navigation foundation story when the stepper renders then current completed and upcoming states stay in a horizontal top-positioned workflow", async ({
    page,
  }) => {
    await openStorybookPreview(page, "foundation-navigation--navigation-patterns", {
      theme: "light",
      brand: "launchpad",
    });

    const audienceStep = page.getByText("Audience", { exact: true });
    const creativeStep = page.getByText("Creative", { exact: true });
    const reviewStep = page.getByText("Review", { exact: true });

    await expect(audienceStep).toBeVisible();
    await expect(creativeStep).toBeVisible();
    await expect(reviewStep).toBeVisible();
    await expect(page.getByText("complete", { exact: true })).toBeVisible();
    await expect(page.getByText("current", { exact: true })).toBeVisible();
    await expect(page.getByText("upcoming", { exact: true })).toBeVisible();

    const audienceBox = await audienceStep.boundingBox();
    const creativeBox = await creativeStep.boundingBox();
    const reviewBox = await reviewStep.boundingBox();

    expect(audienceBox).not.toBeNull();
    expect(creativeBox).not.toBeNull();
    expect(reviewBox).not.toBeNull();

    expect(audienceBox!.x).toBeLessThan(creativeBox!.x);
    expect(creativeBox!.x).toBeLessThan(reviewBox!.x);
    expect(Math.abs(audienceBox!.y - creativeBox!.y)).toBeLessThan(40);
    expect(Math.abs(creativeBox!.y - reviewBox!.y)).toBeLessThan(40);
  });

  test.skip("[P1] Given the actions foundation story when keyboard users tab to the primary action in dark midnight mode then focus-visible treatment remains obvious", async ({
    page,
  }) => {
    await openStorybookPreview(page, "foundation-actions--buttons", {
      theme: "dark",
      brand: "midnight",
    });

    const primaryButton = page.getByRole("button", { name: "Primary" });
    await expect(primaryButton).toBeVisible();

    await page.keyboard.press("Tab");
    await expect(primaryButton).toBeFocused();

    const focusStyles = await readComputedStyle(primaryButton);

    expect(
      focusStyles.outlineWidth !== "0px"
        || focusStyles.outlineStyle !== "none"
        || focusStyles.boxShadow !== "none",
    ).toBeTruthy();
  });
});
