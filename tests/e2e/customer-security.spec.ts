import { expect, test } from "@playwright/test";
import { signInTestCustomer } from "../support/helpers/customer-session";
import { resolveBaseUrl } from "../support/helpers/env";

test("customer sessions protect connections and mock execution ownership in the running app", async ({
  request,
  playwright,
}, testInfo) => {
  expect((await request.get("/api/connections")).status()).toBe(401);
  expect(
    (await request.post("/api/ads/createCampaign", { data: {} })).status(),
  ).toBe(401);
  // Next treats _internal as a private folder and does not expose this alias.
  expect(
    (
      await request.post("/api/_internal/ads/createCampaign", { data: {} })
    ).status(),
  ).toBe(404);
  expect(
    (await request.post("/api/mock-ads/meta", { data: {} })).status(),
  ).toBe(401);
  const alice = await signInTestCustomer(request, testInfo.project.name);
  const other = await playwright.request.newContext({
    baseURL: resolveBaseUrl(),
  });
  try {
    const bob = await signInTestCustomer(
      other,
      testInfo.project.name,
      undefined,
      "other",
    );
    const submitted = await request.post("/api/ads/createCampaign", {
      headers: { Origin: resolveBaseUrl() },
      data: {
        payload: {
          userId: bob.id,
          name: "Customer isolation check",
          objective: "CLICKS",
          budget: { dailyBudget: 1, currency: "GBP" },
          accessToken: "must-not-be-logged",
        },
        platforms: ["META"],
      },
    });
    expect(submitted.status()).toBe(200);
    const execution = await submitted.json();
    expect(execution.success).toBe(true);
    const record = await request.get(
      `/api/ads/executions?id=${execution.executionId}`,
    );
    expect(record.status()).toBe(200);
    const body = await record.json();
    expect(body.ownerId).toBe(alice.id);
    expect(body.requestPayload.userId).toBe(alice.id);
    expect(JSON.stringify(body)).not.toContain("must-not-be-logged");
    expect(
      (
        await other.get(`/api/ads/executions?id=${execution.executionId}`)
      ).status(),
    ).toBe(404);
    const overwrite = await other.post("/api/mock-ads/meta", {
      headers: {
        Origin: resolveBaseUrl(),
        "x-ads-invocation-id": body.invocations[0].id,
      },
      data: { path: "overwrite" },
    });
    expect(overwrite.status()).toBe(404);
    expect(
      (
        await request.delete("/api/auth/session", {
          headers: { Origin: "https://untrusted.test" },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await request.delete("/api/auth/session", {
          headers: { Origin: resolveBaseUrl() },
        })
      ).status(),
    ).toBe(200);
    expect((await request.get("/api/connections")).status()).toBe(401);
  } finally {
    await other.dispose();
  }
});
