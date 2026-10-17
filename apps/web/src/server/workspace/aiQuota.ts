import type { PrismaClient } from "../../generated/prisma/client";
import { fail } from "../security/errors";
function limit(value: string | undefined, fallback: number, maximum: number) {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > maximum) fail("AI_CONFIG_INVALID", 503, "The AI usage limit needs a valid server configuration.");
  return n;
}
/** Reserve before external I/O. Failed/timed-out requests remain counted: they may incur cost. */
export async function reserveAiRequest(db: PrismaClient, ownerId: string, now = new Date(), env: NodeJS.ProcessEnv = process.env) {
  const windows = [
    { kind: "day", ms: 86400000, max: limit(env.AI_DAILY_REQUEST_LIMIT, 50, 1000) },
    { kind: "minute", ms: 60000, max: limit(env.AI_MINUTE_REQUEST_LIMIT, 5, 60) },
  ];
  await db.$transaction(async tx => {
    await tx.aiRequestWindow.deleteMany({ where: { ownerId, windowStart: { lt: new Date(now.getTime() - 2 * 86400000) } } });
    for (const window of windows) {
      const start = new Date(Math.floor(now.getTime() / window.ms) * window.ms);
      const key = `${ownerId}:${window.kind}:${start.toISOString()}`;
      const row = await tx.aiRequestWindow.upsert({ where: { key }, create: { key, ownerId, windowStart: start, count: 1 }, update: { count: { increment: 1 } } });
      if (row.count > window.max) fail("AI_USAGE_LIMIT", 429, `Your workspace has reached its AI ${window.kind === "day" ? "daily" : "per-minute"} request limit. Try again after the window resets.`);
    }
  });
}
