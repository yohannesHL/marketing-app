import { Temporal } from "@js-temporal/polyfill";
import { fail } from "../security/errors";

export type SendWindow = { timeZone: string; weekdays: number[]; startMinute: number; endMinute: number };
export type TimingResult = { at: string; reason: "WITHIN_WINDOW" | "NEXT_WINDOW" } | { expired: true };
function invalid(): never { return fail("INVALID_SEND_WINDOW", 400, "Use a named timezone, weekdays 1–7 and an increasing minute range within 0–1440."); }
const iso = (instant: Temporal.Instant) => instant.toString({ fractionalSecondDigits: 3 });

export function validateSendWindow(value: unknown): SendWindow {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["timeZone", "weekdays", "startMinute", "endMinute"].includes(key))) invalid();
  const timeZone = input.timeZone === undefined ? "UTC" : input.timeZone;
  if (typeof timeZone !== "string" || timeZone.length > 128 || !timeZone || /^[+-]/.test(timeZone)) invalid();
  try { Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(timeZone); } catch { invalid(); }
  const weekdays = input.weekdays === undefined ? [1, 2, 3, 4, 5] : input.weekdays;
  const startMinute = input.startMinute === undefined ? 540 : input.startMinute, endMinute = input.endMinute === undefined ? 1020 : input.endMinute;
  if (!Array.isArray(weekdays) || !weekdays.length || weekdays.length > 7 || new Set(weekdays).size !== weekdays.length
    || weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7)
    || !Number.isInteger(startMinute) || !Number.isInteger(endMinute)
    || Number(startMinute) < 0 || Number(endMinute) > 1440 || Number(startMinute) >= Number(endMinute)) invalid();
  return { timeZone, weekdays: [...weekdays], startMinute: Number(startMinute), endMinute: Number(endMinute) };
}

function instant(value: string): Temporal.Instant {
  try { return Temporal.Instant.from(value); } catch { return fail("INVALID_EMAIL_TIME", 400, "Supply an exact timestamp with an offset."); }
}
export function resolveLocal(localISO: string, zone: string): { instant: string; resolution: "EXACT" | "AMBIGUOUS_LATER" | "GAP_FIRST_VALID" } {
  validateSendWindow({ timeZone: zone });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(localISO))
    fail("INVALID_EMAIL_TIME", 400, "Supply a local ISO date and time without an offset.");
  try {
    const local = Temporal.PlainDateTime.from(localISO, { overflow: "reject" });
    const earlier = local.toZonedDateTime(zone, { disambiguation: "earlier" }), later = local.toZonedDateTime(zone, { disambiguation: "later" });
    if (later.toPlainDateTime().equals(local)) return { instant: iso(later.toInstant()),
      resolution: earlier.epochNanoseconds === later.epochNanoseconds ? "EXACT" : "AMBIGUOUS_LATER" };
    const transition = earlier.getTimeZoneTransition("next");
    if (!transition || transition.epochNanoseconds > later.epochNanoseconds || Temporal.PlainDateTime.compare(transition.toPlainDateTime(), local) <= 0)
      throw new Error("Unresolved transition");
    return { instant: iso(transition.toInstant()), resolution: "GAP_FIRST_VALID" };
  } catch { return fail("INVALID_EMAIL_TIME", 400, "The local date and time could not be resolved."); }
}
export function nextSendAt(notBefore: string, window: SendWindow, expiresAt?: string): TimingResult {
  const start = instant(notBefore), expiry = expiresAt === undefined ? undefined : instant(expiresAt);
  if (expiry && Temporal.Instant.compare(start, expiry) >= 0) return { expired: true };
  const config = validateSendWindow(window), localDate = start.toZonedDateTimeISO(config.timeZone).toPlainDate();
  for (let offset = 0; offset < 14; offset++) {
    const date = localDate.add({ days: offset });
    if (!config.weekdays.includes(date.dayOfWeek)) continue;
    const boundary = (minute: number) => instant(resolveLocal((minute === 1440 ? date.add({ days: 1 }).toPlainDateTime("00:00")
      : date.toPlainDateTime({ hour: Math.floor(minute / 60), minute: minute % 60 })).toString(), config.timeZone).instant);
    const opening = boundary(config.startMinute), closing = boundary(config.endMinute);
    if (Temporal.Instant.compare(opening, closing) >= 0 || Temporal.Instant.compare(start, closing) >= 0) continue;
    const candidate = Temporal.Instant.compare(start, opening) >= 0 ? start : opening;
    if (expiry && Temporal.Instant.compare(candidate, expiry) >= 0) return { expired: true };
    return { at: iso(candidate), reason: Temporal.Instant.compare(candidate, start) === 0 ? "WITHIN_WINDOW" : "NEXT_WINDOW" };
  }
  return fail("NO_VALID_SEND_WINDOW", 409, "No valid send window was found within 14 local dates.");
}
