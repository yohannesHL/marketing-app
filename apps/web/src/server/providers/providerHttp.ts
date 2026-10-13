import { SecurityError } from "../security/errors";

export type ProviderErrorDetail = { code: string; field?: string };

/** Only deliberately selected provider metadata crosses this error boundary. */
export class ProviderHttpError extends SecurityError {
  constructor(
    code: string,
    status: number,
    message: string,
    public readonly details: ProviderErrorDetail[] = [],
    public readonly requestId?: string,
  ) {
    super(code, status, message);
    this.name = "ProviderHttpError";
  }
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,100}$/.test(value)
    ? value : undefined;
}

function providerError(response: Response, body: unknown): ProviderHttpError {
  const payload = record(body);
  if (payload.error === "invalid_grant")
    return new ProviderHttpError("RECONNECT_REQUIRED", 409, "Google authorization expired or was revoked. Reconnect your account.");
  if (payload.error === "access_denied")
    return new ProviderHttpError("CONSENT_DENIED", 400, "Google permission was declined. Connect again when ready.");
  const google = record(payload.error);
  const details: ProviderErrorDetail[] = [];
  for (const failure of Array.isArray(google.details) ? google.details : []) {
    const errors = record(failure).errors;
    for (const error of Array.isArray(errors) ? errors : []) {
      const row = record(error);
      const code = Object.values(record(row.errorCode)).map(identifier).find(Boolean);
      if (!code) continue;
      const elements = record(row.location).fieldPathElements;
      const fields = (Array.isArray(elements) ? elements : [])
        .map((element) => record(element).fieldName)
        .filter((field): field is string => typeof field === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,80}$/.test(field));
      details.push({ code, ...(fields.length ? { field: fields.join(".") } : {}) });
    }
  }
  const requestId = response.headers.get("request-id") ?? response.headers.get("google-ads-request-id");
  const safeId = requestId && /^[A-Za-z0-9_-]{1,128}$/.test(requestId) ? requestId : undefined;
  if (details.some((d) => d.code === "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION"))
    return new ProviderHttpError("PROJECT_ACCESS_REQUIRED", 403, "This Google Cloud project needs Google Ads production access.", details, safeId);
  if (response.status === 401)
    return new ProviderHttpError("RECONNECT_REQUIRED", 409, "Google authorization is no longer valid. Reconnect your account.", details, safeId);
  if (response.status === 403)
    return new ProviderHttpError("PROVIDER_PERMISSION_DENIED", 403, "Google denied access. Check the account role, manager context and Cloud project access.", details, safeId);
  if (response.status === 429)
    return new ProviderHttpError("PROVIDER_RATE_LIMITED", 429, "Google request limits were reached. Try again later.", details, safeId);
  return new ProviderHttpError("PROVIDER_REQUEST_FAILED", 502, "Google could not complete this request.", details, safeId);
}

/** Prevents redirects from forwarding secrets; callers construct paths from configured hosts. */
export async function providerJson(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new ProviderHttpError("PROVIDER_UNAVAILABLE", 502, "Google could not be reached. Try again later.");
  }
  let body: unknown;
  try { body = await response.json(); }
  catch {
    if (!response.ok) throw providerError(response, {});
    throw new ProviderHttpError("INVALID_PROVIDER_RESPONSE", 502, "Google returned an incomplete response.");
  }
  if (!response.ok) throw providerError(response, body);
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new ProviderHttpError("INVALID_PROVIDER_RESPONSE", 502, "Google returned an incomplete response.");
  return body as Record<string, unknown>;
}

export function mockoonOrigin(value?: string): string | undefined {
  if (!value) return undefined;
  let url: URL;
  try { url = new URL(value); }
  catch { throw new ProviderHttpError("INVALID_CONFIG", 503, "The Mockoon origin is invalid."); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new ProviderHttpError("INVALID_CONFIG", 503, "Mockoon must use an explicit HTTP loopback origin.");
  return url.origin;
}
