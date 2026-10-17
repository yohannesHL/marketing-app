import { fail } from "../security/errors";
import { timestamp } from "./trackingValidation";

export function reportRange(from: unknown, to: unknown, asOf: Date) {
  let start: Date, end: Date;
  try { start = new Date(timestamp(from)); end = new Date(timestamp(to)); }
  catch { return fail("INVALID_REPORT_RANGE", 400, "Choose valid ISO dates with explicit timezones."); }
  if (start >= end || end > asOf) fail("INVALID_REPORT_RANGE", 400, "Choose an entry interval with from before to, ending no later than now.");
  return { from: start, to: end };
}
