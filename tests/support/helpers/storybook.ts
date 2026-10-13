import type { Locator, Page } from "@playwright/test";

import { resolveStorybookBaseUrl } from "./env";

type StorybookGlobals = Partial<Record<"theme" | "brand", string>>;

export function buildStorybookPreviewUrl(storyId: string, globals: StorybookGlobals = {}): string {
  const url = new URL("/iframe.html", resolveStorybookBaseUrl());
  url.searchParams.set("id", storyId);
  url.searchParams.set("viewMode", "story");

  const globalsParam = Object.entries(globals)
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => `${key}:${value}`)
    .join(";");

  if (globalsParam) {
    url.searchParams.set("globals", globalsParam);
  }

  return url.toString();
}

export async function openStorybookPreview(
  page: Page,
  storyId: string,
  globals: StorybookGlobals = {},
): Promise<void> {
  await page.goto(buildStorybookPreviewUrl(storyId, globals), {
    waitUntil: "domcontentloaded",
  });
}

export async function readComputedStyle(locator: Locator): Promise<{
  backgroundColor: string;
  color: string;
  outlineColor: string;
  outlineStyle: string;
  outlineWidth: string;
  boxShadow: string;
  fontSize: string;
}> {
  return locator.evaluate((element) => {
    const styles = window.getComputedStyle(element);

    return {
      backgroundColor: styles.backgroundColor,
      color: styles.color,
      outlineColor: styles.outlineColor,
      outlineStyle: styles.outlineStyle,
      outlineWidth: styles.outlineWidth,
      boxShadow: styles.boxShadow,
      fontSize: styles.fontSize,
    };
  });
}

export async function readNearestPaintedBackground(locator: Locator): Promise<string | null> {
  return locator.evaluate((element) => {
    let current: Element | null = element;

    while (current) {
      const backgroundColor = window.getComputedStyle(current).backgroundColor;
      if (backgroundColor && backgroundColor !== "rgba(0, 0, 0, 0)" && backgroundColor !== "transparent") {
        return backgroundColor;
      }
      current = current.parentElement;
    }

    return null;
  });
}
