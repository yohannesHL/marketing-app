export type Provider = "GOOGLE" | "META";
export type ProviderMode = "mock" | "live" | "disabled";
export interface Destination {
  id: string; externalId: string; kind: string; name: string | null;
  currency: string | null; timezone: string | null; selected: boolean;
  available: boolean; lastCheckedAt: string | null;
  metadata: { contexts?: { loginCustomerId: string | null }[]; manager?: boolean;
    status?: string; canRead?: boolean; canWrite?: string; tasks?: string[] } | null;
  selectedContext: { loginCustomerId?: string | null } | null;
}
export interface Connection {
  id: string; provider: string; providerUserId: string; capability: string;
  connectionMode: string; status: string; credentialVersion: number;
  expiresAt?: string | null; destinations: Destination[];
}
export interface ProviderSettings {
  mode: ProviderMode;
  paid: { provider: Provider; enabled: boolean; reason?: string; liveWritesEnabled: boolean }[];
  social: { provider: string; label: string; enabled: boolean }[];
}

export class ConnectionUiError extends Error {
  constructor(readonly code: string, readonly status: number) { super(errorHelp(code)); }
}
const HELP: Record<string, string> = {
  INVALID_LOGIN: "Email or password is incorrect. Try again.",
  LOGIN_LIMIT: "Too many sign-in attempts. Wait a moment, then try again.",
  PROVIDER_REVOKED: "Provider access was revoked. Start a new connection to authorize it again.",
  INVALID_ORIGIN: "This request did not come from your workspace. Reload this page and try again.",
  UNAUTHENTICATED: "Your session has ended. Sign in again to continue.",
  SESSION_REQUIRED: "Sign in to manage your connections.",
  RECONNECT_REQUIRED: "This authorization has expired or was revoked. Reconnect and approve access again.",
  MISSING_PERMISSION: "Required permissions are missing. Reconnect and approve the requested access.",
  CONSENT_DENIED: "Permission was declined. No new connection was saved. You can connect again when ready.",
  INVALID_OAUTH_STATE: "This connection attempt expired or was already used. Start a new connection.",
  PROVIDER_IDENTITY_MISMATCH: "Choose the provider identity that belongs to this connection when reconnecting.",
  SUBJECT_MISMATCH: "The provider identity changed. Reconnect using the original account.",
  MISSING_REFRESH_TOKEN: "Offline access was not granted. Reconnect and approve access again.",
  ACCOUNT_UNAVAILABLE: "This account is unavailable or cannot manage campaigns. Refresh accounts or choose another account.",
  ACCOUNT_NOT_ACCESSIBLE: "This account is no longer accessible. Refresh accounts and select an available account.",
  INVALID_ACCOUNT_CONTEXT: "Refresh accounts and choose a verified Google access path before selecting this account.",
  INVALID_SELECTION: "Choose an available account and its verified access path.",
  STALE_CREDENTIALS: "This connection changed during the request. Refresh this page and try again.",
  CONNECTION_MODE_MISMATCH: "This connection belongs to another environment. Use a connection for the current mode.",
  PROVIDER_RATE_LIMITED: "The provider is receiving too many requests. Wait a moment, then try again.",
  RATE_LIMITED: "Too many attempts. Wait a moment, then try again.",
  PROJECT_ACCESS_REQUIRED: "Google API project access needs attention. Contact your workspace administrator.",
  PROVIDER_PERMISSION_DENIED: "The provider did not allow this action. Check your account permissions or reconnect.",
  PROVIDER_UNAVAILABLE: "The provider is temporarily unavailable. Try again shortly.",
  INVALID_CONFIG: "This provider is not configured for this environment. Contact your workspace administrator.",
  PROVIDER_DISABLED: "This provider is not enabled in this environment.",
  PROVIDER_AUTHORIZATION_FAILED: "The provider could not complete authorization. Start the connection again.",
  NOT_FOUND: "This connection or account is no longer available. Refresh this page.",
};
export function errorHelp(code?: string) {
  return (code && HELP[code]) || "The request could not be completed. Refresh this page or try again shortly.";
}
export async function connectionRequest<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { method, credentials: "same-origin", cache: "no-store",
      headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch { throw new ConnectionUiError("PROVIDER_UNAVAILABLE", 503); }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ConnectionUiError(typeof data?.code === "string" ? data.code : "REQUEST_FAILED", response.status);
  return data as T;
}
export function safeReturnTo(value: string | null) {
  return value && (["/", "/connections", "/campaigns/create", "/social", "/social/create"].includes(value)
    || /^\/social\/posts\/[A-Za-z0-9_-]{1,128}$/.test(value)) ? value : "/connections";
}
export function providerLabel(provider: string) {
  return ({ GOOGLE: "Google Ads", META: "Meta Ads", YOUTUBE: "YouTube", TIKTOK: "TikTok", LINKEDIN: "LinkedIn", X: "X" } as Record<string, string>)[provider] ?? provider;
}
export function statusLabel(status: string) {
  return ({ CONNECTED: "Connected", RECONNECT_REQUIRED: "Reconnect required", DISCONNECTED: "Disconnected", REVOKED: "Access revoked", EXPIRED: "Expired" } as Record<string, string>)[status] ?? "Access needs attention";
}
export function checkedAt(value: string | null) {
  if (!value || Number.isNaN(Date.parse(value))) return "Not checked yet";
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
export function authorizationTarget(url: string, provider: Provider, mode: ProviderMode) {
  const target = new URL(url);
  const trustedLive = target.protocol === "https:" && (provider === "GOOGLE"
    ? target.hostname === "accounts.google.com" : target.hostname === "www.facebook.com");
  const trustedMock = mode === "mock" && target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
  if (target.username || target.password || !(mode === "live" ? trustedLive : trustedMock))
    throw new ConnectionUiError("INVALID_CONFIG", 503);
  return target.href;
}

export interface SelectedAccountReadiness {
  mode: "mock" | "live"; writesEnabled: false; success: boolean; partial: boolean;
  outcomes: { destinationId: string; provider: Provider; success: boolean; canRead: boolean;
    canWrite: "DISABLED"; account?: { externalId: string; name?: string; currency?: string; timezone?: string };
    error?: { code: string; message: string; status: number } }[];
}
