import { fail } from "../security/errors";
import type { XPriceSchedule } from "./x";

export const X_COST_OPERATIONS = ["USER_READ", "POST_READ", "POST_CREATE", "POST_CREATE_URL", "POST_DELETE", "MEDIA_UPLOAD", "MEDIA_INIT", "MEDIA_APPEND", "MEDIA_FINALIZE", "MEDIA_STATUS"] as const;
/** Operator-confirmed conservative rates; no guessed media price or provider credit balance. */
export function xPriceSchedule(environment: NodeJS.ProcessEnv = process.env): XPriceSchedule {
  let value: unknown;
  try { value = JSON.parse(environment.X_API_PRICES ?? "null"); } catch { /* Fail closed below. */ }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== X_COST_OPERATIONS.length ||
    X_COST_OPERATIONS.some(key => !(key in value!) || !Number.isSafeInteger((value as Record<string, unknown>)[key]) || Number((value as Record<string, unknown>)[key]) < 0))
    fail("API_COST_APPROVAL_REQUIRED", 503, "Configure verified conservative X API rates for every supported operation.");
  return Object.freeze({ ...value }) as XPriceSchedule;
}
