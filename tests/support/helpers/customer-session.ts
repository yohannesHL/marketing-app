import type { APIRequestContext, BrowserContext } from "@playwright/test";
import { resolveBaseUrl } from "./env";

export async function signInTestCustomer(
  request: APIRequestContext,
  project: string,
  context?: BrowserContext,
  prefix = "e2e",
) {
  const origin = resolveBaseUrl();
  const data = {
    email: `${prefix}-${project}@example.test`,
    password: "isolated-test-password-for-fixtures",
  };
  const response = await request.post("/api/auth/login", {
    data,
    headers: { Origin: origin },
  });
  if (!response.ok())
    throw new Error(
      `Test sign-in failed (${response.status()}); start the isolated test app.`,
    );
  if (context) {
    const state = await request.storageState();
    await context.addCookies(state.cookies);
  }
  return response.json() as Promise<{ id: string }>;
}
