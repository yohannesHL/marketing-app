import { fail } from "../security/errors";
import { fields, object, text, timestamp } from "../funnels/trackingValidation";
import { validateSendWindow, type SendWindow } from "./emailTiming";

export type CampaignWait = { kind: "IMMEDIATE" } | { kind: "DURATION"; seconds: number } | { kind: "DATE"; at: string };
export type CampaignDefinition = { schemaVersion: 1; senderId: string; subscriptionCategory: string; timeZone: string;
  sendWindow: SendWindow; steps: { id: string; subject: string; html?: string; text?: string; wait: CampaignWait; expiresAfterDueSeconds: number }[] };
export function subscriptionCategory(value: unknown) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(value))
    fail("INVALID_SUBSCRIPTION_CATEGORY", 400, "Use a subscription category such as consultation or product-news.");
  return value;
}
export function emailEnvironment(value: unknown): "TEST" | "LIVE" {
  if (value !== "TEST" && value !== "LIVE") fail("INVALID_EMAIL_INPUT", 400, "Choose TEST or LIVE."); return value;
}
export function emailRevision(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) fail("INVALID_EMAIL_INPUT", 400, "Supply the reviewed draft revision."); return Number(value);
}
function seconds(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 31_536_000)
    fail("INVALID_EMAIL_DEFINITION", 400, "Use a duration between one second and one year."); return Number(value);
}
function body(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || new TextEncoder().encode(value).byteLength > 65_536 || /\u0000/.test(value))
    fail("INVALID_EMAIL_DEFINITION", 400, "Message content must be nonempty text up to 64 KiB.");
  return value;
}
export function validateCampaignDefinition(value: unknown): CampaignDefinition {
  const input = object(value); fields(input, ["schemaVersion", "senderId", "subscriptionCategory", "timeZone", "sendWindow", "steps"]);
  if (input.schemaVersion !== 1) fail("INVALID_EMAIL_DEFINITION", 400, "Use campaign definition version 1.");
  const timeZone = input.timeZone === undefined ? "UTC" : text(input.timeZone, 128);
  const windowInput = object(input.sendWindow ?? {});
  if (windowInput.timeZone !== undefined && windowInput.timeZone !== timeZone)
    fail("INVALID_EMAIL_DEFINITION", 400, "The send window and campaign must use the same timezone.");
  const sendWindow = validateSendWindow({ ...windowInput, timeZone });
  if (!Array.isArray(input.steps) || input.steps.length > 50) fail("INVALID_EMAIL_DEFINITION", 400, "Use up to 50 message steps.");
  const steps = input.steps.map(value => {
    const step = object(value); fields(step, ["id", "subject", "html", "text", "wait", "expiresAfterDueSeconds"]);
    const waitInput = object(step.wait ?? { kind: "IMMEDIATE" }); let wait: CampaignWait;
    if (waitInput.kind === "IMMEDIATE") { fields(waitInput, ["kind"]); wait = { kind: "IMMEDIATE" }; }
    else if (waitInput.kind === "DURATION") { fields(waitInput, ["kind", "seconds"]); wait = { kind: "DURATION", seconds: seconds(waitInput.seconds) }; }
    else if (waitInput.kind === "DATE") { fields(waitInput, ["kind", "at"]); wait = { kind: "DATE", at: timestamp(waitInput.at) }; }
    else fail("UNSUPPORTED_CAMPAIGN_WAIT", 400, "This version supports immediate, duration and date draft steps.");
    const html = body(step.html), content = body(step.text);
    if (!html && !content) fail("INVALID_EMAIL_DEFINITION", 400, "Supply HTML or plain text message content.");
    return { id: text(step.id, 128), subject: text(step.subject, 300), ...(html === undefined ? {} : { html }),
      ...(content === undefined ? {} : { text: content }), wait, expiresAfterDueSeconds: seconds(step.expiresAfterDueSeconds ?? 604800) };
  });
  if (new Set(steps.map(step => step.id)).size !== steps.length) fail("INVALID_EMAIL_DEFINITION", 400, "Step IDs must be unique.");
  const result: CampaignDefinition = { schemaVersion: 1, senderId: text(input.senderId, 128),
    subscriptionCategory: subscriptionCategory(input.subscriptionCategory), timeZone, sendWindow, steps };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 131_072) fail("INVALID_EMAIL_DEFINITION", 400, "Campaign definitions are limited to 128 KiB.");
  return result;
}
export function assertCampaignExecutionSupported(definition: CampaignDefinition) {
  if (definition.steps.length !== 1 || definition.steps[0].wait.kind !== "IMMEDIATE")
    fail("CAMPAIGN_TIMING_UNAVAILABLE", 409, "Publish one immediate message in this release. Timed and multi-step execution requires the automation runner.");
}
