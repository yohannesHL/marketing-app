/** Resolve customer wall-clock input without assuming the browser's timezone. */
export function validTimeZone(zone: string) {
  if (
    !zone ||
    zone.length > 100 ||
    !(zone.includes("/") || ["UTC", "GMT"].includes(zone))
  )
    return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone }).format();
    return true;
  } catch {
    return false;
  }
}
function localParts(instant: Date, zone: string) {
  const values: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant))
    values[part.type] = part.value;
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}
export function localTimeInput(instant: string | Date, zone: string) {
  const date = typeof instant === "string" ? new Date(instant) : instant;
  return Number.isNaN(date.getTime()) || !validTimeZone(zone)
    ? ""
    : localParts(date, zone);
}
export function scheduleInstants(localTime: string, zone: string): string[] {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(localTime) ||
    !validTimeZone(zone)
  )
    return [];
  const wallClock = new Date(`${localTime}:00.000Z`);
  const wall = wallClock.getTime();
  if (Number.isNaN(wall) || wallClock.toISOString().slice(0, 16) !== localTime)
    return [];
  const offsets = new Set<number>();
  // Adjacent offsets include both sides of ordinary/half-hour DST transitions
  // and large timezone changes; the final wall-time roundtrip is authoritative.
  for (let hour = -36; hour <= 36; hour += 6) {
    const sample = new Date(wall + hour * 3_600_000);
    const offset =
      Date.parse(`${localParts(sample, zone)}:00.000Z`) - sample.getTime();
    if (Number.isFinite(offset)) offsets.add(offset);
  }
  const instants = new Set<string>();
  for (const offset of offsets) {
    const candidate = new Date(wall - offset);
    if (
      Number.isFinite(candidate.getTime()) &&
      localParts(candidate, zone) === localTime
    )
      instants.add(candidate.toISOString());
  }
  return [...instants].sort();
}
export function publicationTime(
  instant: string | null | undefined,
  zone = "UTC",
) {
  if (!instant || Number.isNaN(Date.parse(instant)) || !validTimeZone(zone))
    return "Time not chosen";
  return new Intl.DateTimeFormat(undefined, {
    timeZone: zone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(instant));
}
export function utcTime(instant: string | null | undefined) {
  return instant && !Number.isNaN(Date.parse(instant))
    ? `${new Date(instant).toISOString().replace("T", " ").replace(".000Z", " UTC")}`
    : "UTC time not chosen";
}
