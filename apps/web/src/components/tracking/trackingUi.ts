export type TrackingEnvironment = "TEST" | "LIVE";
export type TrackingProvider = "NATIVE" | "API" | "CALENDLY" | "SHOPIFY" | "RESEND";
export type SourceConfig = { allowedOrigins: string[]; allowedEvents: string[]; propertyKeys: string[]; correlationField?: "utm_content" };
export type SourceSummary = { id: string; name: string; provider: TrackingProvider; environment: TrackingEnvironment; externalAccountId: string;
  status: "ACTIVE" | "PAUSED" | "DISCONNECTED"; generation: number; config: SourceConfig; credentialsSaved?: boolean;
  credentialsManagedBy?: string; createdAt: string; health: { configured: boolean; receivingEvents: boolean; matchedEvents: number;
    unresolvedEvents: number; conflictingEvents: number; explanation: string; readyForAutomation: false;
    lastReceipt: { id: string; receivedAt: string; occurredAt: string; type: string; status: string; reason: string | null; subjectId: string | null } | null } };
export type TrackingSubject = { id: string; kind: "CONTACT" | "SALES" | "PURCHASE"; contactId: string | null; environment: TrackingEnvironment;
  createdAt: string; contact: { id: string; name: string | null; email: string | null } | null };
export type TrackingEvent = { id: string; type: string; environment: TrackingEnvironment; status: string; reason: string | null;
  subjectId: string | null; contactId: string | null; factId: string | null; occurredAt: string; receivedAt: string;
  ingestionMode: string; processingMode: string; late: boolean; duplicates: number; conflicts: number;
  evidence: { resource?: { kind: string; id: string }; references?: { kind: string; id: string }[]; subjectKind?: string;
    authority?: string; verification?: string; properties?: Record<string, string | number | boolean | null>; providerTopic?: string; resourceUpdatedAt?: string } | null };
export type EventPage = { events: TrackingEvent[]; nextCursor: string | null };
export type TrackingAudit = { id: string; eventId: string | null; action: string; reason: string; actorId: string | null; createdAt: string };
export const PROVIDER_LABELS: Record<TrackingProvider, string> = { NATIVE: "Website and forms", API: "Server API", CALENDLY: "Calendly", SHOPIFY: "Shopify", RESEND: "Resend email" };
export const SOURCE_EVENTS: Record<Exclude<TrackingProvider, "RESEND">, string[]> = {
  NATIVE: ["enquiry.accepted", "page.viewed", "product.viewed", "checkout.observed"],
  API: ["enquiry.accepted", "deal.won", "deal.lost", "order.paid", "page.viewed", "product.viewed", "checkout.observed"],
  CALENDLY: ["booking.confirmed", "booking.cancelled"], SHOPIFY: ["order.paid", "refund.created", "refund.succeeded"],
};
export const PROPERTY_DEFAULTS: Record<Exclude<TrackingProvider, "RESEND">, string[]> = {
  NATIVE: ["path", "referrer", "utm_source", "utm_medium", "utm_campaign", "utm_content", "campaign"],
  API: ["campaign", "amount", "currency"], CALENDLY: ["status", "rescheduled"],
  SHOPIFY: ["amount", "currency", "presentmentAmount", "presentmentCurrency", "financialStatus", "occurredAtBasis", "test"],
};
const HELP: Record<string, string> = {
  UNAUTHENTICATED: "Your session ended. Sign in again to continue.", INVALID_ORIGIN: "Reload the workspace before trying again.",
  NOT_FOUND: "This item is unavailable in the selected account or environment.", TRACKING_LIVE_DISABLED: "LIVE tracking is disabled on this deployment. Ask your administrator to complete the live setup.",
  INVALID_TRACKING_INPUT: "Check the source fields, event names and property names, then try again.",
  MANAGED_EMAIL_SOURCE: "Manage this source through its email connection. Its events match saved message sends.",
  REPLAY_UNAVAILABLE: "This evidence cannot be replayed. Redacted records stay private; review or reconcile quarantined provider evidence.",
  TRACKING_PROVIDER_AUTH_REQUIRED: "The provider token or read permissions need attention. Replace the complete credentials and retry.",
  TRACKING_PROVIDER_RESOURCE_NOT_FOUND: "The provider could not find that resource. This does not prove a booking or payment did not happen.",
  TRACKING_PROVIDER_RATE_LIMITED: "The provider is limiting requests. Wait before retrying.",
  TRACKING_PROVIDER_UNAVAILABLE: "The provider could not be reached. No outcome has been inferred.",
  INVALID_MATCH: "Choose a subject with the matching business kind and environment.",
  INVALID_CORRELATION: "Choose an owned sales enquiry with a known recipient email.",
  TRACKING_SOURCE_UNAVAILABLE: "Activate this source and check its environment before continuing.",
  UNSUPPORTED_CORRELATION: "Enable Calendly enquiry correlation before creating a token.",
  P2002: "A source for this account and environment already exists.",
};
export class TrackingUiError extends Error {
  constructor(readonly code: string, readonly status: number, safeMessage?: string) {
    super(HELP[code] ?? safeMessage ?? "The request could not be completed. Refresh and try again.");
  }
}
export async function trackingRequest<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  let response: Response;
  try { response = await fetch(path, { method, credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json",
    ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
  catch { throw new TrackingUiError("NETWORK_UNAVAILABLE", 503, "Could not reach LaunchPad. Check your connection and try again."); }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new TrackingUiError(typeof data?.code === "string" ? data.code : "REQUEST_FAILED", response.status);
  return data as T;
}
export function trackingError(error: unknown) { return error instanceof TrackingUiError ? error.message : "The request could not be completed. Refresh and try again."; }
export function trackingSignIn(error: unknown) {
  if (error instanceof TrackingUiError && error.status === 401) {
    const destination = /^\/tracking(?:\/[A-Za-z0-9_-]{1,128})?$/.test(window.location.pathname) ? window.location.pathname : "/tracking";
    window.location.replace(`/sign-in?returnTo=${encodeURIComponent(destination)}`); return true;
  }
  return false;
}
export function dateLabel(value: string | null | undefined) { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Not observed"; }
export function subjectLabel(subject: TrackingSubject) { return `${subject.contact?.name || subject.contact?.email || "Unidentified contact"} · ${subject.kind.toLowerCase()} · ${subject.id.slice(-10)}`; }
export function sourceLink(source: Pick<SourceSummary, "id" | "environment">) { return `/tracking/${encodeURIComponent(source.id)}?environment=${source.environment}`; }
export const EVENT_STATUS: Record<string, string> = { QUEUED: "Waiting for matching", MATCHED: "Matched", UNMATCHED: "Needs identity review", QUARANTINED: "Evidence needs review", BLOCKED: "Source changed", REDACTED: "Evidence removed" };
export function identityHelp(provider: TrackingProvider) {
  return { NATIVE: "An accepted form creates a separate enquiry. Consented visitor observations can be linked to that enquiry. A form does not grant marketing consent.",
    API: "Send a stable enquiry, deal or order reference. Keep the stable contact identity separate; matching does not merge people by email address.",
    CALENDLY: "A booking uses its invitee identity. To link an existing enquiry, use a short-lived utm_content token plus matching recipient evidence. Shared email addresses alone are insufficient.",
    SHOPIFY: "Order and refund references identify each purchase journey. A checkout token can link earlier checkout evidence; successful refund transactions are distinct from refund creation.",
    RESEND: "Email evidence is bound to its saved message send and recipient scope. CONTACT delivery does not select an arbitrary sales enquiry." }[provider];
}
