import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  EMAIL_REQUIRED_EVENTS, EMAIL_SUPPORTED_EVENTS, EmailProviderError,
  type BuiltEmailRequest, type EmailEnvironment, type EmailEventType, type EmailProvider,
  type EmailProviderCode, type EmailProviderContext, type EmailProviderOperation,
  type EmailSendResult, type FrozenEmailRequest, type OutgoingEmail, type ResendProviderConfig,
  type RetrievedEmail, type VerifiedEmailWebhook, type WebhookVerificationInput,
} from "./emailProvider";

const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_WEBHOOK_BYTES = 1024 * 1024;
const WINDOW_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_DIGEST = /^[0-9a-f]{64}$/;
const TAG = /^[A-Za-z0-9_-]{1,256}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function invalid(): never { throw new EmailProviderError("INVALID_REQUEST"); }
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function object(value: unknown): Record<string, unknown> { if (!isObject(value)) invalid(); return value; }
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid();
}
function boundedString(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && !value.length)) invalid();
  return value;
}
function headerString(value: unknown, max: number): string {
  const result = boundedString(value, max);
  if (CONTROL.test(result)) invalid();
  return result;
}
function address(value: unknown): string {
  const result = headerString(value, 254);
  const at = result.indexOf("@");
  const local = result.slice(0, at), domain = result.slice(at + 1);
  if (at < 1 || at > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..") ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) ||
    !/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(domain)) invalid();
  return result;
}
function fromAddress(value: unknown): string {
  const result = headerString(value, 600);
  if (result.includes("<")) {
    const match = /^(?:"(?:[^"\\]|\\["\\])*"|[^<>"\\]+) <([^<>]+)>$/.exec(result);
    if (!match) invalid();
    address(match[1]);
  } else address(result);
  return result;
}
function loopback(url: URL) { return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname); }
function unsubscribeUrl(value: unknown, environment: EmailEnvironment): string {
  const result = headerString(value, 2048);
  if (/[<>\s]/.test(result)) invalid();
  let parsed: URL;
  try { parsed = new URL(result); } catch { return invalid(); }
  if (parsed.username || parsed.password || parsed.hash ||
    (parsed.protocol !== "https:" && !(environment === "TEST" && parsed.protocol === "http:" && loopback(parsed)))) invalid();
  return result;
}
function timestamp(value: unknown): string {
  const text = boundedString(value, 80);
  // Resend read responses may use a space instead of T and a +00 timezone.
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(text)) invalid();
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) invalid();
  return date.toISOString();
}
function equalSecret(a: string, b: string) {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}
function secretBytes(secret: string): Buffer {
  if (typeof secret !== "string" || !secret.startsWith("whsec_") || secret.length > 1024) invalid();
  const encoded = secret.slice(6);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) invalid();
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length < 16 || bytes.length > 128 || bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) invalid();
  return bytes;
}
function tags(value: unknown, array: boolean): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  if (value === undefined || value === null) return result;
  const rows: unknown[] = array ? (Array.isArray(value) ? value : invalid()) :
    Object.entries(object(value)).map(([name, value]) => ({ name, value }));
  if (rows.length > 75) invalid();
  for (const row of rows) {
    const item = object(row);
    const name = boundedString(item.name, 256), value = boundedString(item.value, 256);
    if (!TAG.test(name) || !TAG.test(value) || Object.hasOwn(result, name)) invalid();
    result[name] = value;
  }
  return result;
}
function addresses(value: unknown, optional = false): string[] {
  if (optional && (value === undefined || value === null)) return [];
  if (!Array.isArray(value) || value.length > 50 || (!optional && value.length === 0)) invalid();
  return value.map(address);
}

function buildRequest(input: OutgoingEmail, environment: EmailEnvironment): BuiltEmailRequest {
  const data = object(input);
  exactKeys(data, ["from", "to", "replyTo", "subject", "html", "text", "unsubscribeUrl", "sendRef"]);
  const sender = object(input.from);
  exactKeys(sender, ["address", "name"]);
  const senderAddress = address(sender.address);
  const name = sender.name === undefined ? undefined : headerString(sender.name, 200);
  const from = name ? `${JSON.stringify(name)} <${senderAddress}>` : senderAddress;
  const to = address(input.to), subject = headerString(input.subject, 1000);
  const html = input.html === undefined ? undefined : boundedString(input.html, MAX_REQUEST_BYTES);
  const text = input.text === undefined ? undefined : boundedString(input.text, MAX_REQUEST_BYTES);
  if (!html && !text) invalid();
  const replyTo = input.replyTo === undefined ? undefined : address(input.replyTo);
  const url = unsubscribeUrl(input.unsubscribeUrl, environment);
  if (typeof input.sendRef !== "string" || !TAG.test(input.sendRef)) invalid();
  const body = JSON.stringify({ from, to: [to], subject, ...(html === undefined ? {} : { html }),
    ...(text === undefined ? {} : { text }), ...(replyTo === undefined ? {} : { reply_to: replyTo }),
    headers: { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    tags: [{ name: "launchpad_send", value: input.sendRef }] });
  if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new EmailProviderError("PAYLOAD_TOO_LARGE", 413);
  return { body, requestDigest: hash(body) };
}

function validateFrozen(request: FrozenEmailRequest, environment: EmailEnvironment, now: Date) {
  if (typeof request.body !== "string" || Buffer.byteLength(request.body) > MAX_REQUEST_BYTES ||
    !HEX_DIGEST.test(request.requestDigest) || hash(request.body) !== request.requestDigest ||
    !/^[A-Za-z0-9_.:/-]{1,256}$/.test(request.idempotencyKey)) invalid();
  const data = object(JSON.parse(request.body));
  // Reject duplicate JSON keys/noncanonical encodings as well as unsupported provider fields.
  if (JSON.stringify(data) !== request.body) invalid();
  exactKeys(data, ["from", "to", "subject", "html", "text", "reply_to", "headers", "tags"]);
  fromAddress(data.from); headerString(data.subject, 1000);
  if (addresses(data.to).length !== 1) invalid();
  if (data.reply_to !== undefined) address(data.reply_to);
  if (data.html === undefined && data.text === undefined) invalid();
  if (data.html !== undefined) boundedString(data.html, MAX_REQUEST_BYTES);
  if (data.text !== undefined) boundedString(data.text, MAX_REQUEST_BYTES);
  const headers = object(data.headers);
  exactKeys(headers, ["List-Unsubscribe", "List-Unsubscribe-Post"]);
  if (headers["List-Unsubscribe-Post"] !== "List-Unsubscribe=One-Click") invalid();
  const unsubscribe = boundedString(headers["List-Unsubscribe"], 2050);
  if (!unsubscribe.startsWith("<") || !unsubscribe.endsWith(">")) invalid();
  unsubscribeUrl(unsubscribe.slice(1, -1), environment);
  const refs = tags(data.tags, true);
  if (Object.keys(refs).length !== 1 || !refs.launchpad_send) invalid();
  for (const tag of data.tags as unknown[]) exactKeys(object(tag), ["name", "value"]);
  const first = request.firstSubmittedAt instanceof Date ? request.firstSubmittedAt.getTime() : NaN;
  const expiry = request.idempotencyExpiresAt instanceof Date ? request.idempotencyExpiresAt.getTime() : NaN;
  if (!Number.isFinite(first) || !Number.isFinite(expiry) || first > now.getTime() || expiry <= first || expiry - first > WINDOW_MS) invalid();
  if (now.getTime() >= expiry) throw new EmailProviderError("IDEMPOTENCY_EXPIRED");
}

type RpcResult = { kind: "NOT_SENT"; code: EmailProviderCode } | { kind: "UNCERTAIN"; code: EmailProviderCode } |
  { kind: "RESPONSE"; status: number; value: unknown; retryAfterMs?: number };

function classify(result: Extract<RpcResult, { kind: "RESPONSE" }>): EmailSendResult {
  const name = isObject(result.value) && typeof result.value.name === "string" ? result.value.name : "";
  const retry = result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs };
  if (result.status === 409 && ["concurrent_idempotent_requests", "invalid_idempotent_request"].includes(name))
    return { kind: "UNKNOWN", code: name === "concurrent_idempotent_requests" ? "REQUEST_IN_PROGRESS" : "IDEMPOTENCY_CONFLICT", ...retry };
  if (result.status === 401 && ["missing_api_key", "validation_error", "restricted_api_key"].includes(name))
    return { kind: "REJECTED", code: name === "restricted_api_key" ? "PERMISSION_DENIED" : "AUTHENTICATION_FAILED", retryable: false };
  if (result.status === 403 && ["invalid_permission", "restricted_api_key", "suspended_api_key", "validation_error", "email_above_quota"].includes(name))
    return { kind: "REJECTED", code: name === "validation_error" ? "SENDER_UNAVAILABLE" : "PERMISSION_DENIED", retryable: false };
  if ((result.status === 400 && ["invalid_idempotency_key", "validation_error"].includes(name)) ||
    (result.status === 422 && ["invalid_parameter", "missing_required_field", "missing_required_parameter", "validation_error"].includes(name)))
    return { kind: "REJECTED", code: "VALIDATION_REJECTED", retryable: false };
  if (result.status === 429 && ["daily_quota_exceeded", "monthly_quota_exceeded", "rate_limit_exceeded"].includes(name))
    return { kind: "REJECTED", code: "RATE_LIMITED", retryable: true, ...retry };
  return { kind: "UNKNOWN", code: "PROVIDER_UNCERTAIN", ...retry };
}

function normalizedEmail(value: unknown, expectedId: string): RetrievedEmail {
  const data = object(value);
  if (data.id !== expectedId || !UUID.test(expectedId)) invalid();
  const result: RetrievedEmail = { providerMessageId: expectedId, from: fromAddress(data.from), to: addresses(data.to),
    subject: headerString(data.subject, 1000),
    html: data.html == null ? null : boundedString(data.html, MAX_WEBHOOK_BYTES, true),
    text: data.text == null ? null : boundedString(data.text, MAX_WEBHOOK_BYTES, true),
    replyTo: data.reply_to == null ? [] : typeof data.reply_to === "string" ? [address(data.reply_to)] : addresses(data.reply_to, true),
    cc: addresses(data.cc, true), bcc: addresses(data.bcc, true), createdAt: timestamp(data.created_at),
    lastEvent: headerString(data.last_event, 80), tags: tags(data.tags, true) };
  if (data.message_id !== undefined) result.messageId = headerString(data.message_id, 1000);
  return result;
}

function verifyWebhook(input: WebhookVerificationInput): VerifiedEmailWebhook {
  try {
    if (!(input.rawBody instanceof Uint8Array) || input.rawBody.byteLength > MAX_WEBHOOK_BYTES || !input.rawBody.byteLength)
      throw new EmailProviderError("PAYLOAD_TOO_LARGE", 413);
    const id = input.headers.get("svix-id"), time = input.headers.get("svix-timestamp"), signatures = input.headers.get("svix-signature");
    if (!id || !/^[A-Za-z0-9_-]{1,256}$/.test(id) || !time || !/^\d{1,12}$/.test(time) || !signatures || signatures.length > 4096) invalid();
    const seconds = Number(time), now = input.now.getTime();
    if (!Number.isFinite(now) || Math.abs(now / 1000 - seconds) > 300) invalid();
    const expected = createHmac("sha256", secretBytes(input.webhookSecret)).update(`${id}.${time}.`).update(input.rawBody).digest();
    let verified = false;
    for (const signature of signatures.split(/\s+/)) {
      const parts = /^v1,([A-Za-z0-9+/]{43}=)$/.exec(signature);
      if (!parts) continue;
      const bytes = Buffer.from(parts[1], "base64");
      if (bytes.length === expected.length && bytes.toString("base64") === parts[1] && timingSafeEqual(bytes, expected)) verified = true;
    }
    if (!verified) invalid();
    const body = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.rawBody)));
    const type = headerString(body.type, 100);
    if (!/^[a-z][a-z0-9_.-]*$/.test(type)) invalid();
    const result: VerifiedEmailWebhook = { providerDeliveryId: id, rawPayloadDigest: hash(input.rawBody), type,
      supported: EMAIL_SUPPORTED_EVENTS.includes(type as EmailEventType), occurredAt: timestamp(body.created_at),
      to: [], tags: {} };
    if (!result.supported) return result;
    const data = object(body.data);
    if (type.startsWith("suppression.")) {
      const sourceId = data.source_id == null ? null : boundedString(data.source_id, 36);
      if (sourceId !== null && !UUID.test(sourceId)) invalid();
      result.suppression = { email: address(data.email), origin: headerString(data.origin, 80), sourceId };
      if (sourceId) result.providerMessageId = sourceId;
    } else {
      const providerId = boundedString(data.email_id, 36);
      if (!UUID.test(providerId)) invalid();
      result.providerMessageId = providerId;
      result.to = addresses(data.to);
      result.from = fromAddress(data.from);
      result.subject = headerString(data.subject, 1000);
      result.tags = tags(data.tags, false);
      if (data.message_id !== undefined) result.messageId = headerString(data.message_id, 1000);
      if (data.bounce !== undefined) {
        const bounce = object(data.bounce);
        result.bounce = { ...(bounce.type === undefined ? {} : { type: headerString(bounce.type, 80) }),
          ...(bounce.subType === undefined ? {} : { subType: headerString(bounce.subType, 80) }) };
      }
      if (data.suppressed !== undefined) {
        const suppressed = object(data.suppressed);
        result.suppressed = suppressed.type === undefined ? {} : { type: headerString(suppressed.type, 80) };
      }
    }
    return result;
  } catch (error) {
    if (error instanceof EmailProviderError && error.code === "PAYLOAD_TOO_LARGE") throw error;
    throw new EmailProviderError("WEBHOOK_INVALID", 401);
  }
}

/** Each instance is permanently bound to one environment. TEST has no production transport fallback. */
export function createResendProvider(config: ResendProviderConfig): EmailProvider {
  const now = config.now ?? (() => new Date());
  const timeoutMs = config.timeoutMs ?? 15_000, maxResponseBytes = config.maxResponseBytes ?? MAX_WEBHOOK_BYTES;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 ||
    !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_WEBHOOK_BYTES) invalid();
  let origin: string, transport: typeof fetch;
  if (config.environment === "TEST") {
    if (!config.fixture || typeof config.fixture.fetch !== "function") throw new EmailProviderError("MODE_DISABLED", 503);
    let url: URL;
    try { url = new URL(config.fixture.origin); } catch { throw new EmailProviderError("MODE_DISABLED", 503); }
    if (url.protocol !== "http:" || !loopback(url) || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
      throw new EmailProviderError("MODE_DISABLED", 503);
    origin = url.origin; transport = config.fixture.fetch;
  } else if (config.environment === "LIVE") { origin = "https://api.resend.com"; transport = config.fetch ?? fetch; }
  else throw new EmailProviderError("MODE_DISABLED", 503);
  // Capture the mode/gate so a mutated config cannot redirect or enable an existing adapter.
  const environment = config.environment, enabled = environment === "TEST" || (config.environment === "LIVE" && config.liveEnabled === true);

  async function rpc(context: EmailProviderContext, operation: EmailProviderOperation, path: string,
    body?: string, idempotencyKey?: string, expiresAt?: number): Promise<RpcResult> {
    if (!enabled || context.environment !== environment) return { kind: "NOT_SENT", code: "MODE_DISABLED" };
    if (typeof context.apiKey !== "string" || !context.apiKey.length || context.apiKey.length > 4096 || CONTROL.test(context.apiKey))
      return { kind: "NOT_SENT", code: "AUTHENTICATION_FAILED" };
    try { await context.beforeRequest(operation); }
    catch { return { kind: "NOT_SENT", code: "PRECONDITION_FAILED" }; }
    if (expiresAt !== undefined && now().getTime() >= expiresAt) return { kind: "NOT_SENT", code: "IDEMPOTENCY_EXPIRED" };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const task = async (): Promise<RpcResult> => {
      const response = await transport(`${origin}${path}`, { method: body === undefined ? "GET" : "POST", redirect: "error",
        credentials: "omit", cache: "no-store", signal: controller.signal,
        headers: { Authorization: `Bearer ${context.apiKey}`, Accept: "application/json", ...(body === undefined ? {} : {
          "Content-Type": "application/json", "Idempotency-Key": idempotencyKey! }) }, ...(body === undefined ? {} : { body }) });
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new Error(); }
      const length = response.headers.get("content-length");
      if (length && /^\d+$/.test(length) && Number(length) > maxResponseBytes) {
        void response.body?.cancel().catch(() => {});
        throw new EmailProviderError("PAYLOAD_TOO_LARGE");
      }
      if (!response.body) return { kind: "RESPONSE", status: response.status, value: null };
      reader = response.body.getReader();
      const parts: Uint8Array[] = []; let size = 0;
      while (true) {
        const next = await reader.read();
        if (controller.signal.aborted) throw new Error();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > maxResponseBytes) throw new EmailProviderError("PAYLOAD_TOO_LARGE");
        parts.push(next.value);
      }
      let value: unknown = null;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts))); } catch { /* Invalid response stays inconclusive. */ }
      const retry = response.headers.get("retry-after");
      const retryAfterMs = retry && /^\d{1,6}$/.test(retry) ? Math.min(Number(retry) * 1000, 3_600_000) : undefined;
      return { kind: "RESPONSE", status: response.status, value, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
    };
    try {
      return await Promise.race([task(), new Promise<RpcResult>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error()); }, timeoutMs);
      })]);
    } catch (error) {
      return { kind: "UNCERTAIN", code: error instanceof EmailProviderError ? "INVALID_PROVIDER_RESPONSE" : "NETWORK_UNCERTAIN" };
    } finally {
      if (timer) clearTimeout(timer);
      if (reader) void reader.cancel().catch(() => {});
    }
  }
  const codeForRead = (result: RpcResult): EmailProviderCode => result.kind === "RESPONSE" ?
    (result.status >= 200 && result.status < 300 ? "INVALID_PROVIDER_RESPONSE" : (classify(result) as { code: EmailProviderCode }).code) : result.code;
  const provider: EmailProvider = {
    capabilities: Object.freeze({ provider: "RESEND", environment, send: true, retrieveById: true,
      senderReadiness: true, webhookReadiness: true, idempotencyWindowMs: WINDOW_MS,
      events: EMAIL_SUPPORTED_EVENTS, remoteSequenceEnrollment: false, replyDetection: false,
      providerSchedulingUsed: false, unknownIdSearch: false }),
    buildRequest: input => buildRequest(input, environment),
    async send(context, request) {
      try { validateFrozen(request, environment, now()); }
      catch (error) { return { kind: "NOT_SUBMITTED", code: error instanceof EmailProviderError ? error.code : "INVALID_REQUEST" }; }
      const result = await rpc(context, "SEND", "/emails", request.body, request.idempotencyKey, request.idempotencyExpiresAt.getTime());
      if (result.kind === "NOT_SENT") return { kind: "NOT_SUBMITTED", code: result.code };
      if (result.kind === "UNCERTAIN") return { kind: "UNKNOWN", code: result.code };
      if (result.status >= 200 && result.status < 300) {
        return isObject(result.value) && typeof result.value.id === "string" && UUID.test(result.value.id) ?
          { kind: "ACCEPTED", providerMessageId: result.value.id } : { kind: "UNKNOWN", code: "INVALID_PROVIDER_RESPONSE" };
      }
      return classify(result);
    },
    async retrieve(context, providerMessageId) {
      if (!UUID.test(providerMessageId)) return { kind: "UNAVAILABLE", code: "INVALID_REQUEST" };
      const result = await rpc(context, "RETRIEVE", `/emails/${providerMessageId}`);
      if (result.kind === "RESPONSE" && result.status === 404) return { kind: "NOT_FOUND" };
      if (result.kind === "RESPONSE" && result.status === 200) {
        try { return { kind: "FOUND", email: normalizedEmail(result.value, providerMessageId) }; }
        catch { return { kind: "UNAVAILABLE", code: "INVALID_PROVIDER_RESPONSE" }; }
      }
      return { kind: "UNAVAILABLE", code: codeForRead(result),
        ...(result.kind === "RESPONSE" && result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}) };
    },
    async checkSender(context, input) {
      const checkedAt = now().toISOString();
      let domain: string;
      try { domain = address(input.address).split("@")[1].toLowerCase(); if (!UUID.test(input.domainId)) invalid(); }
      catch { return { ready: false, code: "INVALID_REQUEST", reason: "READ_UNAVAILABLE", checkedAt }; }
      const result = await rpc(context, "CHECK_SENDER", `/domains/${input.domainId}`);
      if (result.kind !== "RESPONSE" || result.status !== 200)
        return { ready: false, code: codeForRead(result), reason: "READ_UNAVAILABLE", checkedAt };
      try {
        const data = object(result.value), name = headerString(data.name, 253).toLowerCase(), status = headerString(data.status, 80);
        if (data.id !== input.domainId) invalid();
        if (name !== domain) return { ready: false, code: "SENDER_UNAVAILABLE", reason: "DOMAIN_MISMATCH", checkedAt };
        if (status !== "verified") return { ready: false, code: "SENDER_UNAVAILABLE", reason: "DOMAIN_NOT_VERIFIED", domainStatus: status, checkedAt };
        if (object(data.capabilities).sending !== "enabled") return { ready: false, code: "SENDER_UNAVAILABLE", reason: "SENDING_DISABLED", checkedAt };
        if (typeof data.open_tracking !== "boolean" || typeof data.click_tracking !== "boolean") invalid();
        return { ready: true, domainId: input.domainId, domainName: name, status: "verified", sendingEnabled: true,
          openTracking: data.open_tracking, clickTracking: data.click_tracking, checkedAt };
      } catch { return { ready: false, code: "INVALID_PROVIDER_RESPONSE", reason: "READ_UNAVAILABLE", checkedAt }; }
    },
    async checkWebhook(context, input) {
      const checkedAt = now().toISOString();
      try { secretBytes(input.webhookSecret); if (!UUID.test(input.webhookId) || !HEX_DIGEST.test(input.expectedUrlDigest) ||
        !Array.isArray(input.requiredEvents) || input.requiredEvents.some(type => !EMAIL_SUPPORTED_EVENTS.includes(type))) invalid(); }
      catch { return { ready: false, code: "INVALID_REQUEST", reason: "READ_UNAVAILABLE", checkedAt }; }
      const result = await rpc(context, "CHECK_WEBHOOK", `/webhooks/${input.webhookId}`);
      if (result.kind !== "RESPONSE" || result.status !== 200)
        return { ready: false, code: codeForRead(result), reason: "READ_UNAVAILABLE", checkedAt };
      try {
        const data = object(result.value);
        if (data.id !== input.webhookId) invalid();
        if (data.status !== "enabled") return { ready: false, code: "SENDER_UNAVAILABLE", reason: "WEBHOOK_DISABLED", checkedAt };
        const endpoint = headerString(data.endpoint, 2048);
        if (hash(endpoint) !== input.expectedUrlDigest) return { ready: false, code: "SENDER_UNAVAILABLE", reason: "ENDPOINT_MISMATCH", checkedAt };
        const secret = boundedString(data.signing_secret, 1024); secretBytes(secret);
        if (!equalSecret(secret, input.webhookSecret)) return { ready: false, code: "SENDER_UNAVAILABLE", reason: "SECRET_MISMATCH", checkedAt };
        if (!Array.isArray(data.events) || data.events.length > 100 || data.events.some(type => typeof type !== "string" || !/^[a-z][a-z0-9_.-]{0,99}$/.test(type))) invalid();
        const events = data.events as string[];
        if (input.requiredEvents.some(type => !events.includes(type))) return { ready: false, code: "SENDER_UNAVAILABLE", reason: "MISSING_EVENTS", checkedAt };
        return { ready: true, webhookId: input.webhookId, subscribedEvents: events, checkedAt };
      } catch { return { ready: false, code: "INVALID_PROVIDER_RESPONSE", reason: "READ_UNAVAILABLE", checkedAt }; }
    },
    async validateSender(context, input) {
      const sender = await provider.checkSender(context, { address: input.address, domainId: input.domainId });
      const webhook = await provider.checkWebhook(context, { webhookId: input.providerWebhookId,
        expectedUrlDigest: input.expectedWebhookUrlDigest, webhookSecret: context.webhookSecret, requiredEvents: EMAIL_REQUIRED_EVENTS });
      return { ready: sender.ready && webhook.ready, checkedAt: now().toISOString(), capabilities: provider.capabilities, sender, webhook };
    },
    verifyWebhook,
  };
  return provider;
}
