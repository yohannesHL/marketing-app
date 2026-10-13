import { createHmac, timingSafeEqual } from "node:crypto";

export class MetaSignedRequestError extends Error {
  readonly code = "INVALID_SIGNED_REQUEST";
  readonly status = 400;
  constructor() { super("The Meta callback could not be verified."); this.name = "MetaSignedRequestError"; }
}

/** Verifies form signed_request; deliberately accepts old valid callbacks/retries. */
export function verifyMetaSignedRequest(signedRequest: string, appSecret: string): {
  userId: string; issuedAt?: Date; expiresAt?: Date;
} {
  const reject = (): never => { throw new MetaSignedRequestError(); };
  if (typeof signedRequest !== "string" || signedRequest.length > 32768 ||
      typeof appSecret !== "string" || !appSecret) return reject();
  const segments = signedRequest.split(".");
  if (segments.length !== 2 || segments.some((s) => !/^[A-Za-z0-9_-]+$/.test(s))) return reject();
  const [encodedSignature, payload] = segments;
  const signature = Buffer.from(encodedSignature, "base64url");
  const expected = createHmac("sha256", appSecret).update(payload).digest();
  if (signature.toString("base64url") !== encodedSignature || signature.length !== expected.length ||
      !timingSafeEqual(signature, expected)) return reject();
  let data: Record<string, unknown>;
  try {
    const decoded = Buffer.from(payload, "base64url");
    if (decoded.toString("base64url") !== payload) return reject();
    data = JSON.parse(decoded.toString("utf8"));
  } catch { return reject(); }
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      data.algorithm !== "HMAC-SHA256" || typeof data.user_id !== "string" ||
      !/^\d{1,64}$/.test(data.user_id)) return reject();
  const date = (value: unknown): Date | undefined => {
    if (value === undefined || value === 0) return undefined;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return reject();
    const result = new Date(value * 1000);
    if (!Number.isFinite(result.getTime())) return reject();
    return result;
  };
  return { userId: data.user_id, issuedAt: date(data.issued_at), expiresAt: date(data.expires) };
}
