import test from "node:test";
import assert from "node:assert/strict";
import { nextSendAt, resolveLocal, validateSendWindow } from "../../apps/web/src/server/email/emailTiming";

test("the default send window includes opening, excludes closing and skips weekends", () => {
  const window = validateSendWindow({});
  assert.deepEqual(nextSendAt("2026-10-19T09:00:00Z", window), { at: "2026-10-19T09:00:00.000Z", reason: "WITHIN_WINDOW" });
  assert.deepEqual(nextSendAt("2026-10-16T17:00:00Z", window), { at: "2026-10-19T09:00:00.000Z", reason: "NEXT_WINDOW" });
});

test("named zones resolve repeated times later and gaps at their first valid instant", () => {
  for (const [zone, local, expected, resolution] of [
    ["Europe/London", "2026-10-25T01:30", "2026-10-25T01:30:00.000Z", "AMBIGUOUS_LATER"],
    ["Europe/London", "2026-03-29T01:30", "2026-03-29T01:00:00.000Z", "GAP_FIRST_VALID"],
    ["America/New_York", "2026-11-01T01:30", "2026-11-01T06:30:00.000Z", "AMBIGUOUS_LATER"],
    ["Australia/Lord_Howe", "2026-10-04T02:15", "2026-10-03T15:30:00.000Z", "GAP_FIRST_VALID"],
    ["Australia/Lord_Howe", "2026-04-05T01:45", "2026-04-04T15:15:00.000Z", "AMBIGUOUS_LATER"],
    ["Pacific/Apia", "2011-12-30T12:00", "2011-12-30T10:00:00.000Z", "GAP_FIRST_VALID"],
    ["Asia/Kathmandu", "2026-10-19T09:00", "2026-10-19T03:15:00.000Z", "EXACT"],
  ]) assert.deepEqual(resolveLocal(local, zone), { instant: expected, resolution });
});

test("repeated-clock windows compare instants and expiry is exclusive", () => {
  const window = validateSendWindow({ timeZone: "Europe/London", weekdays: [7], startMinute: 90, endMinute: 150 });
  assert.deepEqual(nextSendAt("2026-10-25T00:45:00Z", window), { at: "2026-10-25T01:30:00.000Z", reason: "NEXT_WINDOW" });
  assert.deepEqual(nextSendAt("2026-10-25T01:45:00Z", window), { at: "2026-10-25T01:45:00.000Z", reason: "WITHIN_WINDOW" });
  assert.deepEqual(nextSendAt("2026-10-25T00:45:00Z", window, "2026-10-25T01:30:00Z"), { expired: true });
});

test("empty skipped windows advance to another date and all-day is explicit", () => {
  const skipped = validateSendWindow({ timeZone: "America/New_York", weekdays: [7], startMinute: 130, endMinute: 140 });
  assert.deepEqual(nextSendAt("2026-03-08T06:00:00Z", skipped), { at: "2026-03-15T06:10:00.000Z", reason: "NEXT_WINDOW" });
  const allDay = validateSendWindow({ weekdays: [1, 2, 3, 4, 5, 6, 7], startMinute: 0, endMinute: 1440 });
  assert.deepEqual(nextSendAt("2026-10-18T23:59:59.999Z", allDay), { at: "2026-10-18T23:59:59.999Z", reason: "WITHIN_WINDOW" });
});

test("invalid zones, calendar dates and unsupported windows fail without fallback", () => {
  for (const invalid of [{ timeZone: "Wrong/Zone" }, { timeZone: "+03:00" }, { timeZone: null }, { weekdays: [] },
    { weekdays: [1, 1] }, { weekdays: [0] }, { startMinute: 1000, endMinute: 100 }, { endMinute: 1441 }, { startMinute: 1.5 }, { other: true }])
    assert.throws(() => validateSendWindow(invalid));
  assert.throws(() => resolveLocal("2026-02-30T12:00", "UTC"));
  assert.throws(() => resolveLocal("2026-10-19T12:00Z", "UTC"));
  assert.throws(() => nextSendAt("2026-10-19T12:00", validateSendWindow({})));
});

test("a nonexistent opening advances to the first valid instant rather than retaining the gap offset", () => {
  const window = validateSendWindow({ timeZone: "America/New_York", weekdays: [7], startMinute: 150, endMinute: 210 });
  assert.deepEqual(nextSendAt("2026-03-08T06:00:00Z", window), { at: "2026-03-08T07:00:00.000Z", reason: "NEXT_WINDOW" });
});
