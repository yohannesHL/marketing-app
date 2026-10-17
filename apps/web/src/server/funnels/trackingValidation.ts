import { createHash, timingSafeEqual } from "node:crypto";
import { fail } from "../security/errors";

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const emailKey = (value: string) => value.trim().toLowerCase();
export function equalSecret(a: string, b: string) {
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_TRACKING_INPUT", 400, "Supply a JSON object.");
  return value as Record<string, unknown>;
}
export function fields(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail("INVALID_TRACKING_INPUT", 400, "Remove unsupported fields.");
}
export function text(value: unknown, max = 200, optional = false): string {
  if (optional && value === undefined) return "";
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value))
    fail("INVALID_TRACKING_INPUT", 400, "Supply a bounded, nonempty text value.");
  return value.trim();
}
export function email(value: unknown) {
  const result = text(value, 254);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) fail("INVALID_TRACKING_INPUT", 400, "Supply a valid email address.");
  return result;
}
export function timestamp(value: unknown) {
  const result = text(value, 40);
  const match = result.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,3})?(Z|[+-]\d\d:\d\d)$/);
  if (!match || !Number.isFinite(Date.parse(result))) fail("INVALID_TRACKING_INPUT", 400, "Supply an ISO timestamp with an explicit timezone.");
  const [, year, month, day, hour, minute, second, zone] = match;
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (+month < 1 || +month > 12 || +day < 1 || +day > days || +hour > 23 || +minute > 59 || +second > 59 ||
    zone !== "Z" && (+zone.slice(1, 3) > 23 || +zone.slice(4, 6) > 59))
    fail("INVALID_TRACKING_INPUT", 400, "Supply a valid calendar date and time.");
  return new Date(result).toISOString();
}
export function strings(value: unknown, max = 30) {
  if (!Array.isArray(value) || value.length > max) fail("INVALID_TRACKING_INPUT", 400, "Supply a bounded list.");
  return [...new Set(value.map(v => text(v, 200)))];
}
export function properties(value: unknown, keys: string[]) {
  const input = object(value ?? {}), result: Record<string, string | number | boolean | null> = {};
  if (Object.keys(input).length > 30) fail("INVALID_TRACKING_INPUT", 400, "Too many properties.");
  for (const [key, val] of Object.entries(input)) {
    if (!keys.includes(key) || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) || /password|secret|token|authorization/i.test(key))
      fail("INVALID_TRACKING_INPUT", 400, "Use configured non-secret property names.");
    if (val !== null && typeof val !== "string" && typeof val !== "boolean" && typeof val !== "number")
      fail("INVALID_TRACKING_INPUT", 400, "Use scalar property values.");
    if (typeof val === "string" && val.length > 1000 || typeof val === "number" && !Number.isFinite(val))
      fail("INVALID_TRACKING_INPUT", 400, "Property value is too large or invalid.");
    result[key] = val as string | number | boolean | null;
  }
  return result;
}
export async function boundedBody(request: Request, limit = 1_048_576) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    fail("INVALID_TRACKING_INPUT", 415, "Use application/json.");
  const reader = request.body?.getReader();
  if (!reader) fail("INVALID_TRACKING_INPUT", 400, "Supply an event body.");
  const chunks: Uint8Array[] = []; let bytes = 0;
  while (true) {
    const next = await reader.read(); if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > limit) { await reader.cancel(); fail("TRACKING_PAYLOAD_LIMIT", 413, "Event body is too large."); }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
export function json(raw: string) {
  try { return object(JSON.parse(raw)); }
  catch { fail("INVALID_TRACKING_INPUT", 400, "Supply a valid JSON object."); }
}
