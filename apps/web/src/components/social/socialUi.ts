import type { Connection } from "../connections/connectionUi";
export type SocialFormat = "TEXT" | "IMAGE" | "SHORT_VIDEO";
export interface SocialMedia {
  id: string;
  mime: string;
  type: "IMAGE" | "VIDEO";
  bytes: number;
  width: number;
  height: number;
  durationMs: number | null;
  expiresAt: string | null;
  status?: string;
  filename?: string | null;
}
export interface SocialVariantInput {
  destinationId: string;
  format: SocialFormat;
  title?: string;
  body?: string;
  mediaIds?: string[];
  providerOptions?: Record<string, unknown>;
}
export interface SocialVariant extends SocialVariantInput {
  id: string;
  provider: string;
  kind: string;
  name: string | null;
  publishingEnabled: boolean;
}
export interface SocialDelivery {
  id: string;
  revisionId: string;
  destinationId: string;
  status: string;
  phase: string;
  dueAt: string;
  timeZone: string;
  attempts: number;
  nextAttemptAt: string | null;
  externalId: string | null;
  publishUrl: string | null;
  errorCode: string | null;
  cancellationRequested: boolean;
  completedAt: string | null;
}
export interface SocialPost {
  id: string;
  title: string;
  category: "SOCIAL_PUBLISHING";
  status: string;
  currentRevision: number;
  generation: number;
  mode: string;
  publishingEnabled: boolean;
  revision: {
    id: string;
    number: number;
    body: string;
    reviewedAt: string | null;
    approvedDestinations: string[] | null;
    media: SocialMedia[];
    variants: SocialVariant[];
  };
  deliveries: SocialDelivery[];
}
export interface SocialDraft {
  title: string;
  body: string;
  mediaIds: string[];
  variants: SocialVariantInput[];
}
export interface SocialList {
  mode: string;
  publishingEnabled: boolean;
  posts: SocialPost[];
}
export const SOCIAL_PLATFORMS = [
  { kind: "YOUTUBE_CHANNEL", label: "YouTube Shorts" },
  { kind: "FACEBOOK_PAGE", label: "Facebook Pages" },
  { kind: "INSTAGRAM_PROFILE", label: "Instagram" },
  { kind: "TIKTOK_PROFILE", label: "TikTok" },
  { kind: "LINKEDIN", label: "LinkedIn" },
  { kind: "X_PROFILE", label: "X" },
];
export function socialLabel(kind: string) {
  return kind.startsWith("LINKEDIN")
    ? "LinkedIn"
    : (SOCIAL_PLATFORMS.find((p) => p.kind === kind)?.label ??
        "Social destination");
}
export function socialDestinations(connections: Connection[], mode: string) {
  return connections
    .filter((c) => c.capability === "SOCIAL")
    .flatMap((connection) =>
      connection.destinations.map((destination) => ({
        connection,
        destination,
        ready:
          connection.status === "CONNECTED" &&
          connection.connectionMode.toLowerCase() === mode &&
          (!connection.expiresAt ||
            Date.parse(connection.expiresAt) > Date.now()) &&
          destination.selected &&
          destination.available &&
          destination.metadata?.canWrite === "ALLOWED",
      })),
    );
}
export function deliveryLabel(status: string) {
  return (
    (
      {
        QUEUED: "Scheduled",
        LEASED: "Processing",
        RETRY_WAIT: "Waiting to retry",
        SUCCEEDED: "Published",
        FAILED: "Failed",
        BLOCKED: "Blocked",
        UNCERTAIN: "Outcome needs checking",
        CANCELLED: "Cancelled",
        SUPERSEDED: "Replaced by a newer revision",
      } as Record<string, string>
    )[status] ?? "Status needs checking"
  );
}
export function socialStatus(status: string) {
  return (
    (
      {
        DRAFT: "Draft",
        APPROVED: "Reviewed",
        SCHEDULED: "Scheduled",
        COMPLETED: "Completed",
        CANCELLED: "Cancelled",
      } as Record<string, string>
    )[status] ?? "Status needs checking"
  );
}
const HELP: Record<string, string> = {
  STALE_REVISION:
    "This draft changed elsewhere. Reload the current revision before saving or reviewing.",
  REVIEW_REQUIRED:
    "Review and approve the exact saved content and destinations before scheduling.",
  PROVIDER_DISABLED:
    "Publishing is blocked until this provider is enabled and validated. Your draft is saved.",
  INVALID_POST:
    "Add a draft title and supported content for each chosen destination.",
  INVALID_MEDIA: "Choose media uploaded to this draft.",
  MEDIA_UNAVAILABLE:
    "Media is unavailable or will expire before delivery. Upload it again or choose an earlier time.",
  INVALID_SCHEDULE:
    "Choose a valid future time within one year and an IANA time zone.",
  UNSUPPORTED_CONTENT:
    "This destination does not support the selected content format or media.",
  INVALID_DESTINATION:
    "Choose a social publishing destination. Advertising access cannot publish social posts.",
  INVALID_SELECTION:
    "Choose the explicit destinations or deliveries you want to update.",
  RECONNECT_REQUIRED:
    "Publishing access needs attention. Reconnect and select the social destination in Connections.",
  MISSING_PERMISSION:
    "Restore the publishing permissions for this destination in Connections.",
  RECONCILIATION_REQUIRED:
    "The provider outcome needs checking. Retrying could publish a duplicate, so retry is blocked.",
  DELIVERY_IN_PROGRESS:
    "This delivery is already processing or needs checking. Refresh its status before changing the time.",
  ALREADY_SCHEDULED:
    "This revision already has deliveries. Use their reschedule controls.",
  IDEMPOTENCY_CONFLICT:
    "This submission already belongs to another reviewed request. Refresh the delivery details.",
  UNAUTHENTICATED: "Your session ended. Sign in to continue.",
  NOT_FOUND: "This post or destination is no longer available.",
  CONNECTION_MODE_MISMATCH:
    "This destination belongs to another environment. Choose a connection for the current mode.",
  INVALID_MEDIA_TYPE: "Choose a supported image or video file.",
  MEDIA_TOO_LARGE: "This file is too large. Choose a smaller file.",
};
export class SocialUiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(
      HELP[code] ??
        "The request could not be completed. Refresh this page or try again.",
    );
  }
}
export async function socialRequest<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  let response: Response;
  const multipart = typeof FormData !== "undefined" && body instanceof FormData;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(!multipart && body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      ...(body === undefined
        ? {}
        : { body: multipart ? (body as FormData) : JSON.stringify(body) }),
    });
  } catch {
    throw new SocialUiError("REQUEST_FAILED", 503);
  }
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new SocialUiError(
      typeof data?.code === "string" ? data.code : "REQUEST_FAILED",
      response.status,
    );
  return data as T;
}
export function postPath(id: string) {
  return `/social/posts/${encodeURIComponent(id)}`;
}
export function mediaPath(id: string) {
  return `/api/social/media/${encodeURIComponent(id)}/content`;
}
export function safePublishUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      [
        "youtube.com",
        "youtu.be",
        "facebook.com",
        "instagram.com",
        "tiktok.com",
        "linkedin.com",
        "x.com",
        "twitter.com",
      ].some(
        (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
      )
      ? url.href
      : null;
  } catch {
    return null;
  }
}
