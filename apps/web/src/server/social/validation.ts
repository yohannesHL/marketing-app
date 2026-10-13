import type { Prisma, SocialMediaAsset, Platform, DestinationKind } from "../../generated/prisma/client";
import { fail } from "../security/errors";
import type { SocialMode, SocialDraftInput, SocialFormat } from "./types";

export const SOCIAL_DESTINATIONS: Partial<Record<Platform, readonly DestinationKind[]>> = {
  GOOGLE: ["YOUTUBE_CHANNEL"], META: ["FACEBOOK_PAGE", "INSTAGRAM_PROFILE"], TIKTOK: ["TIKTOK_PROFILE"],
  LINKEDIN: ["LINKEDIN_MEMBER", "LINKEDIN_ORGANIZATION"], X: ["X_PROFILE"],
};
export function identifiers(value: unknown, maximum = 25): asserts value is string[] {
  if (!Array.isArray(value) || value.length > maximum || value.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) || new Set(value).size !== value.length)
    fail("INVALID_SELECTION", 400, "Supply distinct owned record IDs.");
}
export function schedule(dueAt: unknown, timeZone: unknown, now: Date) {
  if (typeof dueAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(dueAt))
    fail("INVALID_SCHEDULE", 400, "Choose an explicit UTC instant and an IANA time zone.");
  const wall = dueAt.slice(0, 19);
  const wallDate = new Date(`${wall}Z`);
  if (!Number.isFinite(wallDate.getTime()) || wallDate.toISOString().slice(0, 19) !== wall)
    fail("INVALID_SCHEDULE", 400, "Choose a valid calendar date and scheduling instant.");
  const date = new Date(dueAt);
  if (!Number.isFinite(date.getTime()) || date.getTime() < now.getTime() - 300_000 || date.getTime() > now.getTime() + 366 * 86400_000 ||
    typeof timeZone !== "string" || timeZone.length > 100 || !(timeZone.includes("/") || ["UTC", "GMT"].includes(timeZone)))
    fail("INVALID_SCHEDULE", 400, "Choose a valid scheduling instant and IANA time zone.");
  try { new Intl.DateTimeFormat("en", { timeZone }).format(date); }
  catch { fail("INVALID_SCHEDULE", 400, "Choose a valid IANA time zone."); }
  return { dueAt: date, timeZone };
}
export function draft(value: SocialDraftInput) {
  if (!value || typeof value.title !== "string" || !value.title.trim() || value.title.length > 200 ||
    typeof value.body !== "string" || value.body.length > 10000 || !Array.isArray(value.variants) || value.variants.length > 25)
    fail("INVALID_POST", 400, "Supply a post title, content and supported destination variants.");
  identifiers(value.mediaIds, 10);
  identifiers(value.variants.map((v) => v?.destinationId));
  for (const variant of value.variants) {
    if (!variant || !["TEXT", "IMAGE", "SHORT_VIDEO"].includes(variant.format) ||
      (variant.title !== undefined && (typeof variant.title !== "string" || variant.title.length > 200)) ||
      (variant.body !== undefined && (typeof variant.body !== "string" || variant.body.length > 10000)))
      fail("INVALID_POST", 400, "Supply supported text, image or short-video variants.");
    providerOptions(variant.providerOptions);
    identifiers(variant.mediaIds ?? value.mediaIds, 10);
    if ((variant.mediaIds ?? value.mediaIds).some((id) => !value.mediaIds.includes(id)))
      fail("INVALID_MEDIA", 400, "A variant may use only media belonging to this revision.");
    if (variant.format === "TEXT" && !(variant.body ?? value.body).trim())
      fail("INVALID_POST", 400, "Text variants require post content.");
  }
  return value;
}
export function verifyMedia(media: SocialMediaAsset[], ownerId: string, ids: readonly string[], until: Date) {
  if (media.length !== ids.length || media.some((m) => m.ownerId !== ownerId || m.status !== "AVAILABLE" || !m.verifiedAt ||
    !m.storageKey || !/^[a-f0-9]{64}$/.test(m.digest) || m.bytes <= 0 || m.width <= 0 || m.height <= 0 ||
    (m.type === "VIDEO" && (!m.durationMs || m.durationMs <= 0)) || (m.expiresAt && m.expiresAt <= until)))
    fail("MEDIA_UNAVAILABLE", 409, "Use verified owned media that remains available through delivery.");
}
export function verifyFormat(format: SocialFormat, kind: DestinationKind, media: SocialMediaAsset[]) {
  if (format === "TEXT" && ["YOUTUBE_CHANNEL", "INSTAGRAM_PROFILE", "TIKTOK_PROFILE"].includes(kind))
    fail("UNSUPPORTED_CONTENT", 400, "This destination requires supported media.");
  if (format === "IMAGE" && (!media.length || media.some((m) => m.type !== "IMAGE")))
    fail("UNSUPPORTED_CONTENT", 400, "Image variants require verified images.");
  if (format === "SHORT_VIDEO" && (media.length !== 1 || media[0].type !== "VIDEO"))
    fail("UNSUPPORTED_CONTENT", 400, "Short-video variants require one verified video.");
}
export async function ownedDestination(tx: Prisma.TransactionClient, ownerId: string, id: string, mode: SocialMode, now: Date, requiredScopes: readonly string[] = [], allowExpiredForRenewal = false) {
  const destination = await tx.connectionDestination.findFirst({ where: { id, authorization: { userId: ownerId } }, include: { authorization: true } });
  if (!destination) fail("NOT_FOUND", 404, "Social destination not found.");
  const grant = destination.authorization;
  if (grant.capability !== "SOCIAL" || !SOCIAL_DESTINATIONS[grant.provider]?.includes(destination.kind))
    fail("INVALID_DESTINATION", 400, "Choose an owned social publishing destination.");
  if (grant.connectionMode !== mode.toUpperCase()) fail("CONNECTION_MODE_MISMATCH", 409, "Choose a destination belonging to this provider mode.");
  const metadata = destination.metadata as { canWrite?: unknown } | null;
  if (grant.status !== "CONNECTED" || !grant.accessCiphertext || (!allowExpiredForRenewal && grant.expiresAt && grant.expiresAt <= now) ||
    !destination.selected || !destination.available || metadata?.canWrite !== "ALLOWED")
    fail("RECONNECT_REQUIRED", 409, "Reconnect or restore publishing access and select this social destination.");
  if (!Array.isArray(grant.scopes) || requiredScopes.some((scope) => !(grant.scopes as string[]).includes(scope)))
    fail("MISSING_PERMISSION", 403, "Restore the permissions required to publish to this destination.");
  return destination;
}


export function providerOptions(value: unknown): asserts value is Record<string, unknown> | undefined {
  if (value === undefined) return;
  const booleans = ["madeForKids", "containsSyntheticMedia", "disableComment", "disableDuet", "disableStitch", "brandContentToggle",
    "brandOrganicToggle", "commercialContentDisclosure", "musicUsageConsent", "isAigc", "explicitPostingConsent", "shareToFeed", "madeWithAi", "paidPartnership"];
  const keys = [...booleans, "categoryId", "privacyStatus", "privacyLevel", "creatorInfoVersion", "visibility", "maxApiCostMicros"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 64 || JSON.stringify(value).length > 8192)
    fail("INVALID_PROVIDER_OPTIONS", 400, "Supply supported publication controls without credentials or upload URLs.");
  for (const [key, v] of Object.entries(value)) {
    const valid = keys.includes(key) && (booleans.includes(key) ? typeof v === "boolean" :
      key === "categoryId" ? typeof v === "string" && /^\d{1,8}$/.test(v) :
      key === "privacyStatus" ? typeof v === "string" && ["public", "unlisted", "private"].includes(v) :
      key === "privacyLevel" ? typeof v === "string" && /^[A-Z][A-Z0-9_]{0,80}$/.test(v) :
      key === "visibility" ? typeof v === "string" && ["PUBLIC", "CONNECTIONS"].includes(v) :
      key === "maxApiCostMicros" ? (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) || (typeof v === "string" && /^\d{1,15}$/.test(v)) :
      key === "creatorInfoVersion" ? typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v) : false);
    if (!valid) fail("INVALID_PROVIDER_OPTIONS", 400, "Supply supported publication controls without credentials or upload URLs.");
  }
}
