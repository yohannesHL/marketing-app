import type { Prisma } from "../../generated/prisma/client";
import { validateCondition, type Condition } from "../funnels/funnelDefinition";
import { fail } from "../security/errors";
import { fields, object, text, timestamp } from "../funnels/trackingValidation";
import { validateSendWindow, type SendWindow } from "./emailTiming";

export type CampaignWait = { kind: "IMMEDIATE" } | { kind: "DURATION"; seconds: number } | { kind: "DATE"; at: string }
  | { kind: "EVENT"; sourceId: string; type: string; anchor: "ENROLLED" | "WAIT_STARTED"; timeoutSeconds: number;
      onTimeout: "SKIP_STEP" | "STOP_MEMBERSHIP"; condition?: Condition };
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
    else if (waitInput.kind === "EVENT") {
      fields(waitInput, ["kind", "sourceId", "type", "anchor", "timeoutSeconds", "onTimeout", "condition"]);
      if (!["ENROLLED", "WAIT_STARTED"].includes(String(waitInput.anchor)) || !["SKIP_STEP", "STOP_MEMBERSHIP"].includes(String(waitInput.onTimeout)))
        fail("INVALID_CAMPAIGN_WAIT", 400, "Choose an explicit event anchor and timeout outcome.");
      const condition = waitInput.condition === undefined ? undefined : validateCondition(waitInput.condition);
      if (condition) conditionEventKeys(condition);
      wait = { kind: "EVENT", sourceId: text(waitInput.sourceId, 128), type: text(waitInput.type, 128),
        anchor: waitInput.anchor as "ENROLLED" | "WAIT_STARTED", timeoutSeconds: seconds(waitInput.timeoutSeconds),
        onTimeout: waitInput.onTimeout as "SKIP_STEP" | "STOP_MEMBERSHIP", ...(condition ? { condition } : {}) };
    }
    else fail("UNSUPPORTED_CAMPAIGN_WAIT", 400, "Choose an immediate, duration, date or event wait.");
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
  if (!definition.steps.length || definition.steps.length > 50)
    fail("CAMPAIGN_TIMING_UNAVAILABLE", 409, "Publish between one and 50 supported message steps.");
}

/** Event waits cannot observe mutable cross-event properties as historical evidence. */
export function conditionEventKeys(condition: Condition): string[] {
  if ("all" in condition) return condition.all.flatMap(conditionEventKeys);
  if ("any" in condition) return condition.any.flatMap(conditionEventKeys);
  if (condition.field.scope !== "EVENT")
    fail("UNSUPPORTED_CAMPAIGN_WAIT_CONDITION", 400, "Event waits support fields from the matching event only.");
  return [condition.field.key];
}

/** Publication checks real owned source configuration; drafts remain editable before setup. */
export async function assertCampaignSourcesTx(tx: Prisma.TransactionClient,
  scope: { ownerId: string; environment: string; membershipScope: string }, definition: CampaignDefinition) {
  for (const step of definition.steps) {
    const wait = step.wait;
    if (wait.kind !== "EVENT") continue;
    if (scope.membershipScope !== "SUBJECT") fail("CAMPAIGN_EVENT_SCOPE_UNSUPPORTED", 409, "Event waits require a business-subject campaign.");
    const source = await tx.trackingSource.findFirst({ where: { id: wait.sourceId, ownerId: scope.ownerId, environment: scope.environment } });
    const config = source?.config as { allowedEvents?: unknown; propertyKeys?: unknown } | undefined;
    if (!source || source.status !== "ACTIVE" || !Array.isArray(config?.allowedEvents) || !config.allowedEvents.includes(wait.type))
      fail("CAMPAIGN_EVENT_SOURCE_UNAVAILABLE", 409, "Choose an active owned source and configured event in this environment.");
    const keys = wait.condition ? conditionEventKeys(wait.condition) : [];
    if (keys.some(key => !Array.isArray(config.propertyKeys) || !config.propertyKeys.includes(key)))
      fail("CAMPAIGN_EVENT_PROPERTY_UNAVAILABLE", 409, "Configure each event condition property on its source.");
  }
}
