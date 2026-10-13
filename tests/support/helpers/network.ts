import { expect, type Page, type Response } from "@playwright/test";

export async function runWithDocumentResponse(
  page: Page,
  action: () => Promise<void>,
  expectedPath: string,
): Promise<Response> {
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().resourceType() === "document" && response.ok() && url.pathname === expectedPath;
  });

  await action();

  const response = await responsePromise;
  expect(response.ok()).toBeTruthy();

  return response;
}

export async function waitForNoPageErrors(page: Page): Promise<void> {
  const errors: string[] = [];

  page.on("pageerror", (error) => {
    errors.push(error.message);
  });

  await page.waitForLoadState("networkidle");
  expect(errors, `Unexpected page errors:\n${errors.join("\n")}`).toEqual([]);
}
