import type { ReportRatio } from "../../server/funnels/funnelReportingTypes";

export function reportPercent(ratio: ReportRatio) {
  return ratio.value === null ? "—" : `${(ratio.value * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}
export function reportDuration(ms: number | null) {
  if (ms === null) return "Not observed";
  if (ms < 1000) return "Under 1 second";
  const units: [number, string][] = [[86400000, "days"], [3600000, "hours"], [60000, "minutes"], [1000, "seconds"]];
  const [size, name] = units.find(([size]) => ms >= size)!;
  const amount = Math.round(ms / size * 10) / 10;
  return `${amount.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${amount === 1 ? name.slice(0, -1) : name}`;
}
export function reportUtc(iso: string) { return new Date(iso).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC"); }
export function reportLabel(value: string) { return value.toLowerCase().replaceAll("_", " "); }
export function reportCounts(counts: Record<string, number>) {
  return Object.entries(counts).filter(([, count]) => count).map(([name, count]) => `${reportLabel(name)}: ${count}`).join(" · ") || "None recorded";
}
export function reportWindow() {
  const to = new Date();
  return { from: new Date(to.getTime() - 30 * 86400000).toISOString().slice(0, 19), to: to.toISOString().slice(0, 19) };
}
export function reportInstant(value: string) {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?$/.test(value)) throw new Error("Enter both dates and times in UTC.");
  const date = new Date(`${value}Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, value.length) !== value) throw new Error("Enter a valid UTC date and time.");
  return date.toISOString();
}
