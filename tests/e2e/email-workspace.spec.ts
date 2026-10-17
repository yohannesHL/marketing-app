import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";

async function signIn(page: Page, info: TestInfo) {
  await page.goto("/sign-in?returnTo=%2Femail");
  await page
    .getByLabel(/^Email/)
    .fill(`email-${info.project.name}@example.test`);
  await page.getByLabel(/^Password/).fill("Fixture-only-2026!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/email$/);
}
async function campaignFromUi(page: Page, name: string, category: string) {
  await page
    .getByRole("link", { name: "Create email campaign", exact: true })
    .click();
  await page.getByLabel("Campaign name", { exact: true }).fill(name);
  await expect(
    page.getByLabel("Send from", { exact: true }).locator("option"),
  ).toHaveCount(2);
  await page
    .getByLabel("Send from", { exact: true })
    .selectOption({ index: 1 });
  await page
    .getByLabel("Subscription category", { exact: true })
    .fill(category);
  await page
    .getByLabel("Email subject", { exact: true })
    .fill("A personal follow-up");
  await page
    .getByLabel("Message", { exact: true })
    .fill("Thanks for your enquiry. Reply when you are ready to talk.");
  await page
    .getByLabel("All day on selected weekdays", { exact: true })
    .check();
  await page.getByLabel("Saturday", { exact: true }).check();
  await page.getByLabel("Sunday", { exact: true }).check();
  const expiry = page.getByLabel("Expire unsent message after due time", {
    exact: true,
  });
  await expect(expiry).toHaveValue("7");
  // Firefox must accept ordinary whole-day values before native form submission.
  expect(
    await expiry.evaluate((input: HTMLInputElement) => ({
      valid: input.validity.valid,
      message: input.validationMessage,
    })),
  ).toEqual({ valid: true, message: "" });
  await page.getByRole("button", { name: "Create draft", exact: true }).click();
  await expect(page).toHaveURL(/\/email\/campaigns\/[A-Za-z0-9_-]+$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
  return page.url().split("/").at(-1)!;
}
async function publish(page: Page) {
  await page
    .getByRole("button", { name: "Review publication", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Publish reviewed version", exact: true })
    .click();
  await expect(
    page.getByText("Campaign version published.", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Enable new enrollments", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Pause new enrollments", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Enable sending", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Pause sending", exact: true }),
  ).toBeEnabled();
}

test("email campaign forms preserve no-send simulation, audited consent and explicit sequence start", async ({
  page,
}, info) => {
  await signIn(page, info);
  await page.getByText("Add a campaign reference", { exact: true }).click();
  await page
    .getByLabel("Campaign reference name", { exact: true })
    .fill("Autumn social outreach");
  await page
    .getByLabel("Reference type", { exact: true })
    .selectOption("SOCIAL");
  await page
    .getByRole("button", { name: "Create campaign reference", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Autumn social outreach", exact: true }),
  ).toBeVisible();
  const reference = (
    await (
      await page.request.get("/api/marketing-campaigns?environment=TEST")
    ).json()
  ).find((c: { name: string }) => c.name === "Autumn social outreach");
  expect(reference.category).toBe("SOCIAL");
  expect(reference.publishedRevisionId).toBeNull();
  await page
    .getByRole("link", { name: "Email connections", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Verify sender hello@example.test",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("Sender check completed.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Email campaigns", exact: true })
    .click();
  const category = `ui-${randomUUID().slice(0, 8)}`,
    campaignId = await campaignFromUi(
      page,
      "Enquiry follow-up from the editor",
      category,
    );
  await page
    .getByRole("button", { name: "No-send simulation", exact: true })
    .click();
  const providerBefore = await (
    await page.request.get(`${process.env.QA_FUNNEL_PROVIDER_ORIGIN}/__stats`)
  ).json();
  await page.getByLabel("Recipient has consent", { exact: true }).check();
  await page.getByLabel("Sender is ready", { exact: true }).check();
  await page.getByLabel("Campaign sending is enabled", { exact: true }).check();
  await page
    .getByRole("button", { name: "Run no-send simulation", exact: true })
    .click();
  await expect(
    page.getByRole("list", { name: "Simulated sequence history" }),
  ).toContainText("READY");
  expect(
    await (
      await page.request.get(`${process.env.QA_FUNNEL_PROVIDER_ORIGIN}/__stats`)
    ).json(),
  ).toEqual(providerBefore);
  expect(
    (
      await (
        await page.request.get(
          `/api/marketing-campaigns/${campaignId}/memberships`,
        )
      ).json()
    ).memberships,
  ).toEqual([]);
  await page
    .getByRole("button", { name: "Messages & settings", exact: true })
    .click();
  await publish(page);
  await page
    .getByRole("button", { name: "Recipients & history", exact: true })
    .click();
  await page.getByText("Enroll a recipient", { exact: true }).click();
  const picker = page.getByLabel("Business journey recipient", { exact: true });
  await expect(picker.locator("option")).toHaveCount(3);
  await picker.selectOption({ index: 1 });
  await expect(
    page.getByText("UNKNOWN · Not eligible", { exact: false }),
  ).toBeVisible();
  await page
    .getByText("Record a permission or suppression change", { exact: true })
    .click();
  await page
    .getByLabel("Reason for this change", { exact: true })
    .fill("Recipient explicitly requested these follow-ups");
  await page
    .getByLabel("Evidence source", { exact: true })
    .fill("Recorded enquiry form");
  await page
    .getByLabel("Purpose covered by this evidence", { exact: true })
    .fill("Consultation follow-up");
  await page
    .getByRole("button", { name: "Save permission change", exact: true })
    .click();
  await expect(
    page.getByText("OPTED IN · Eligible", { exact: false }),
  ).toBeVisible();
  await page
    .getByLabel("Enrollment reason", { exact: true })
    .fill("Respond to this enquiry");
  await page
    .getByRole("button", { name: "Enroll recipient", exact: true })
    .click();
  const memberLink = page.getByRole("link", { name: /Journey .* · Cycle 1/ });
  await expect(memberLink).toHaveCount(1);
  await memberLink.click();
  await expect(
    page.getByText("Enrolled only. Scheduled work has not been started.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("No send intent has been created.", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Reason for starting this sequence", { exact: true })
    .fill("Start the approved follow-up");
  await page
    .getByRole("button", { name: "Start sequence", exact: true })
    .click();
  await expect(
    page.getByText("Scheduled sequence explicitly authorized.", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Send current message when eligible",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", { name: /· ACCEPTED$/ }),
  ).toBeVisible();
  await page.getByText(/Delivery evidence ·/).click();
  await expect(page.getByText(/Attempt 1 · ACCEPTED/)).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("email-sequence-history.png"),
    fullPage: true,
  });
  const memberId = page.url().split("/").at(-1)!;
  const member = await (
    await page.request.get(`/api/email/memberships/${memberId}`)
  ).json();
  expect(member.steps[0].status).toBe("ACCEPTED");
  expect(member.sends).toHaveLength(1);
});

test("typed waits retain invalid input and a stale draft remains editable after control changes", async ({
  page,
}, info) => {
  await signIn(page, info);
  const category = `ui-${randomUUID().slice(0, 8)}`,
    campaignId = await campaignFromUi(
      page,
      "Timing and draft conflict checks",
      category,
    );
  await publish(page);
  await page.getByRole("button", { name: "Add message", exact: true }).click();
  await page
    .getByLabel("Email subject", { exact: true })
    .fill("A second message");
  await page
    .getByLabel("Message", { exact: true })
    .fill("This step waits for verified evidence.");
  await page
    .getByLabel("When should this message become due?", { exact: true })
    .selectOption("DATE");
  await page
    .getByLabel("Due date and time", { exact: true })
    .fill("2026-12-01T10:00");
  await page
    .getByLabel("When should this message become due?", { exact: true })
    .selectOption("EVENT");
  const sources = await (
    await page.request.get("/api/tracking/sources")
  ).json();
  const source = sources.find(
    (s: { provider: string; environment: string }) =>
      s.provider === "API" && s.environment === "TEST",
  );
  expect(source).toBeTruthy();
  await page
    .getByLabel("Event source", { exact: true })
    .selectOption(source.id);
  await page
    .getByLabel("Event to wait for", { exact: true })
    .selectOption(source.config.allowedEvents[0]);
  await page
    .getByRole("button", { name: "Add condition", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Value type", exact: true })
    .selectOption("number");
  await page
    .getByRole("combobox", { name: "Comparison", exact: true })
    .selectOption("gt");
  await page.getByLabel("Compare with", { exact: true }).fill("12e");
  await expect(
    page.getByRole("button", { name: "Save draft", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "No-send simulation", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("Compare with", { exact: true })).toHaveValue(
    "12e",
  );
  await page.getByLabel("Compare with", { exact: true }).fill("12");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    page.getByText("Campaign draft saved.", { exact: true }),
  ).toBeVisible();
  const saved = await (
    await page.request.get(`/api/marketing-campaigns/${campaignId}`)
  ).json();
  expect(saved.draft.steps[1].wait.kind).toBe("EVENT");
  expect(saved.draft.steps[1].wait.condition.value).toBe(12);
  const response = await page.request.patch(
    `/api/marketing-campaigns/${campaignId}`,
    {
      headers: { Origin: new URL(page.url()).origin },
      data: {
        name: "Changed by another editor",
        draftRevision: saved.draftRevision,
        definition: saved.draft,
      },
    },
  );
  expect(response.ok()).toBeTruthy();
  await page
    .getByLabel("Campaign name", { exact: true })
    .fill("My retained local name");
  await page
    .getByRole("button", { name: "Pause sending", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Enable sending", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "This draft changed",
  );
  await expect(page.getByLabel("Campaign name", { exact: true })).toHaveValue(
    "My retained local name",
  );
  expect(
    (
      await (
        await page.request.get(`/api/marketing-campaigns/${campaignId}`)
      ).json()
    ).name,
  ).toBe("Changed by another editor");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("email-editor-narrow.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  await page
    .getByRole("combobox", { name: "Appearance", exact: true })
    .selectOption("dark");
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("email-editor-dark.png"),
    fullPage: true,
  });
});
