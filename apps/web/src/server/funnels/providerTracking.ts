import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { fail } from "../security/errors";
import type { AdapterSource, NormalizedTrackingEvent, ProviderReceipt, ReconcileResource, Reference, SourceCredentials } from "./trackingTypes";

type ObjectValue = Record<string, unknown>;
const MAX_BYTES = 1_048_576;
const CALENDLY_ORIGIN = "https://api.calendly.com";
const API_VERSION = "2026-10";

function invalid(message = "The provider payload is invalid."): never {
  return fail("TRACKING_INVALID_PROVIDER_PAYLOAD", 400, message);
}
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as ObjectValue;
}
function string(value: unknown, max = 2048): string {
  if (typeof value !== "string" || !value || value.length > max) invalid();
  return value;
}
function optionalString(value: unknown, max = 2048): string | undefined {
  return value === null || value === undefined || value === "" ? undefined : string(value, max);
}
function timestamp(value: unknown): string {
  const result = string(value, 64);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(result)
    || !Number.isFinite(Date.parse(result))) invalid("The provider timestamp is invalid.");
  return new Date(result).toISOString();
}
function digest(raw: string): string { return createHash("sha256").update(raw).digest("hex"); }
function parse(raw: string): ObjectValue {
  if (Buffer.byteLength(raw, "utf8") > MAX_BYTES) fail("TRACKING_PAYLOAD_TOO_LARGE", 413, "The provider payload is too large.");
  try {
    // Node 24 exposes the original number token before IEEE-754 precision is lost.
    const losslessParse = JSON.parse as (text: string, reviver: (key: string, value: unknown, context?: { source?: string }) => unknown) => unknown;
    return object(losslessParse(raw, (_key, value, context) => {
      if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) {
        if (!context?.source || !/^-?\d+$/.test(context.source)) invalid();
        return context.source;
      }
      return value;
    }));
  } catch { invalid(); }
}
function calendlyUri(value: unknown, kind: "users" | "scheduled_events" | "invitees"): string {
  const uri = string(value);
  const segment = "[A-Za-z0-9_-]{1,128}";
  const path = kind === "invitees" ? `scheduled_events/${segment}/invitees/${segment}` : `${kind}/${segment}`;
  if (!new RegExp(`^https://api\\.calendly\\.com/${path}$`).test(uri)) invalid("The Calendly resource identity is invalid.");
  return uri;
}
function signatureMatches(actual: Buffer, expected: Buffer): boolean {
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function verifySignature(source: AdapterSource, credentials: SourceCredentials, headers: Headers, raw: string, now: Date) {
  if (Buffer.byteLength(raw, "utf8") > MAX_BYTES) fail("TRACKING_PAYLOAD_TOO_LARGE", 413, "The provider payload is too large.");
  if (!credentials.signingSecret) fail("TRACKING_MISSING_CREDENTIALS", 409, "Provider signing credentials are required.");
  if (source.provider === "CALENDLY") {
    const match = /^t=(\d{1,12}),\s*v1=([a-fA-F0-9]{64})$/.exec(headers.get("Calendly-Webhook-Signature") ?? "");
    if (!match || !Number.isFinite(now.getTime()) || Math.abs(now.getTime() / 1000 - Number(match[1])) > 180)
      fail("TRACKING_INVALID_SIGNATURE", 401, "The provider signature is invalid or expired.");
    const expected = createHmac("sha256", credentials.signingSecret).update(`${match[1]}.${raw}`).digest();
    if (!signatureMatches(Buffer.from(match[2], "hex"), expected)) fail("TRACKING_INVALID_SIGNATURE", 401, "The provider signature is invalid.");
  } else if (source.provider === "SHOPIFY") {
    const value = headers.get("X-Shopify-Hmac-SHA256") ?? "";
    if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) fail("TRACKING_INVALID_SIGNATURE", 401, "The provider signature is invalid.");
    const actual = Buffer.from(value, "base64");
    const expected = createHmac("sha256", credentials.signingSecret).update(raw).digest();
    if (actual.toString("base64") !== value || !signatureMatches(actual, expected))
      fail("TRACKING_INVALID_SIGNATURE", 401, "The provider signature is invalid.");
  } else fail("TRACKING_UNSUPPORTED_PROVIDER", 400, "This source does not support provider receipts.");
}

function normalizeBooking(source: AdapterSource, payload: ObjectValue, scheduledEvent: ObjectValue, topic: string, verification: "HMAC" | "API", receiptKey: string): NormalizedTrackingEvent {
  if (topic !== "invitee.created" && topic !== "invitee.canceled") invalid("The Calendly topic is unsupported.");
  const uri = calendlyUri(payload.uri, "invitees");
  const eventUri = calendlyUri(payload.event, "scheduled_events");
  if (uri.split("/invitees/")[0] !== eventUri || calendlyUri(scheduledEvent.uri, "scheduled_events") !== eventUri) invalid("The Calendly resource identities do not match.");
  const configuredUser = calendlyUri(source.externalAccountId, "users");
  if (!Array.isArray(scheduledEvent.event_memberships) || !scheduledEvent.event_memberships.some(member => object(member).user === configuredUser))
    fail("TRACKING_PROVIDER_ACCOUNT_MISMATCH", 403, "The Calendly event does not belong to this source.");
  const canceled = topic === "invitee.canceled";
  const updatedAt = timestamp(payload.updated_at);
  const cancellation = payload.cancellation ? object(payload.cancellation) : undefined;
  const references: Reference[] = [{ kind: "CALENDLY_EVENT", id: eventUri }];
  for (const key of ["old_invitee", "new_invitee"] as const) {
    if (payload[key] !== undefined && payload[key] !== null) references.push({ kind: "BOOKING", id: calendlyUri(payload[key], "invitees") });
  }
  const tracking = payload.tracking ? object(payload.tracking) : undefined;
  const email = optionalString(payload.email, 320);
  return {
    type: canceled ? "booking.cancelled" : "booking.confirmed", providerTopic: topic,
    dedupeKey: `${receiptKey}:${topic}:${uri}`, factKey: `${topic}:${uri}`,
    occurredAt: canceled ? timestamp(cancellation?.created_at ?? payload.updated_at) : timestamp(payload.created_at),
    resourceUpdatedAt: updatedAt, authority: "PROVIDER_VERIFIED", verification,
    resource: { kind: "BOOKING", id: uri }, references,
    properties: { rescheduled: payload.rescheduled === true, status: optionalString(payload.status) ?? null },
    correlationToken: source.config.correlationField === "utm_content" ? optionalString(tracking?.utm_content, 1024) : undefined,
    correlationEmail: email,
    quarantineReason: payload.status !== (canceled ? "canceled" : "active") ? "INCOHERENT_BOOKING_STATUS" : undefined,
  };
}

function shopDomain(source: AdapterSource): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/.test(source.externalAccountId))
    fail("TRACKING_INVALID_SOURCE", 409, "The Shopify source must have a canonical shop domain.");
  return source.externalAccountId;
}
function shopId(value: unknown, kind: "Order" | "Refund" | "OrderTransaction" | "Customer", gid?: unknown): string {
  let id: string;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) invalid("The provider resource identity lost precision.");
    id = String(value);
  } else id = string(value, 128);
  const prefix = `gid://shopify/${kind}/`;
  if (id.startsWith(prefix)) id = id.slice(prefix.length);
  if (!/^[1-9]\d{0,19}$/.test(id) || BigInt(id) > 18_446_744_073_709_551_615n) invalid("The Shopify resource identity is invalid.");
  const canonical = prefix + id;
  if (gid !== undefined && gid !== null && gid !== canonical) invalid("The Shopify resource identities do not match.");
  return canonical;
}
type ReceiptContext = {
  topic: string; key: string; verification: "HMAC" | "API";
  deliveryId?: string; eventId?: string; apiVersion: string;
};
function shopEvent(context: ReceiptContext, type: string, resource: Reference, occurredAt: string): NormalizedTrackingEvent {
  return {
    type, resource, occurredAt, references: [], properties: {}, authority: "PROVIDER_VERIFIED",
    providerTopic: context.topic, providerDeliveryId: context.deliveryId,
    providerEventId: context.eventId, providerApiVersion: context.apiVersion,
    dedupeKey: `${context.key}:${type}:${resource.id}`, verification: context.verification,
  };
}
function modeMismatch(source: AdapterSource, test: unknown): string | undefined {
  return typeof test !== "boolean" || test !== (source.environment === "TEST") ? "PROVIDER_MODE_MISMATCH" : undefined;
}
function money(amount: unknown, currency: unknown): { amount: string; currency: string } | undefined {
  if (typeof amount !== "string" || amount.length > 80 || !/^\d+(?:\.\d{1,18})?$/.test(amount)
    || typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency) || ["XXX", "XTS"].includes(currency)) return undefined;
  return { amount, currency };
}
function moneyProperties(value: unknown): NormalizedTrackingEvent["properties"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const bag = object(value);
  const shop = bag.shop_money ? object(bag.shop_money) : undefined;
  const presentment = bag.presentment_money ? object(bag.presentment_money) : undefined;
  const shopMoney = shop && money(shop.amount, shop.currency_code);
  const presentmentMoney = presentment && money(presentment.amount, presentment.currency_code);
  if (!shopMoney || !presentmentMoney) return undefined;
  return { amount: shopMoney.amount, currency: shopMoney.currency, presentmentAmount: presentmentMoney.amount, presentmentCurrency: presentmentMoney.currency };
}
function normalizeOrder(source: AdapterSource, body: ObjectValue, context: ReceiptContext): NormalizedTrackingEvent {
  const id = shopId(body.id, "Order", body.admin_graphql_api_id);
  const updatedAt = timestamp(body.updated_at);
  const event = shopEvent(context, "order.paid", { kind: "ORDER", id }, updatedAt);
  const amounts = moneyProperties(body.total_price_set);
  event.factKey = "order.paid";
  event.resourceUpdatedAt = updatedAt;
  event.subjectKind = "PURCHASE";
  event.createsSubject = true;
  event.references = [{ kind: "ORDER", id }];
  if (body.checkout_token !== null && body.checkout_token !== undefined) event.references.push({ kind: "CHECKOUT", id: string(body.checkout_token, 256) });
  if (body.customer !== null && body.customer !== undefined) {
    const customer = object(body.customer);
    // Customer identity links a contact; it must never merge distinct order subjects.
    event.contactIdentity = { kind: "CUSTOMER", id: shopId(customer.id, "Customer", customer.admin_graphql_api_id) };
    const email = optionalString(customer.email, 320);
    const name = [optionalString(customer.first_name, 256), optionalString(customer.last_name, 256)].filter(Boolean).join(" ") || undefined;
    if (email || name) event.contact = { ...(email ? { email } : {}), ...(name ? { name } : {}) };
  }
  event.properties = { ...(amounts ?? {}), financialStatus: optionalString(body.financial_status) ?? null, test: typeof body.test === "boolean" ? body.test : null, occurredAtBasis: "resource.updated_at" };
  event.quarantineReason = modeMismatch(source, body.test) ?? (body.financial_status !== "paid" ? "INCOHERENT_PAID_STATUS" : !amounts ? "INCOMPLETE_MONEY" : undefined);
  return event;
}
function normalizeRefund(source: AdapterSource, body: ObjectValue, context: ReceiptContext): NormalizedTrackingEvent[] {
  const refundId = shopId(body.id, "Refund", body.admin_graphql_api_id);
  const orderId = shopId(body.order_id, "Order");
  if (!Array.isArray(body.transactions) || body.transactions.length > 1000) invalid();
  const transactions = body.transactions.map(object);
  const refs: Reference[] = [{ kind: "ORDER", id: orderId }, { kind: "REFUND", id: refundId }];
  const created = shopEvent(context, "refund.created", { kind: "ORDER", id: orderId }, timestamp(body.created_at));
  created.factKey = `refund.created:${source.id}:${refundId}`;
  created.dedupeKey += `:${refundId}`;
  created.references = refs;
  created.resourceUpdatedAt = body.updated_at ? timestamp(body.updated_at) : undefined;
  created.quarantineReason = body.order_test !== undefined ? modeMismatch(source, body.order_test)
    : transactions.length === 0 ? "PROVIDER_MODE_UNVERIFIED" : transactions.map(tx => modeMismatch(source, tx.test)).find(Boolean);
  for (const tx of transactions) {
    if (shopId(tx.order_id, "Order") !== orderId) created.quarantineReason ??= "INCOHERENT_REFUND_ORDER";
    if (modeMismatch(source, tx.test)) created.quarantineReason ??= "PROVIDER_MODE_MISMATCH";
    if (tx.kind !== "refund" && tx.kind !== "suggested_refund") created.quarantineReason ??= "INCOHERENT_REFUND_TRANSACTION_KIND";
    if (!["success", "pending", "failure", "error", "unknown", "awaiting_response"].includes(String(tx.status))) created.quarantineReason ??= "UNKNOWN_REFUND_TRANSACTION_STATUS";
  }
  const events = [created];
  const seen = new Set<string>();
  for (const tx of transactions) {
    const txId = shopId(tx.id, "OrderTransaction", tx.admin_graphql_api_id);
    if (seen.has(txId)) invalid("A refund contains a duplicate transaction identity.");
    seen.add(txId);
    if (tx.kind !== "refund" || tx.status !== "success") continue;
    const event = shopEvent(context, "refund.succeeded", { kind: "ORDER", id: orderId }, timestamp(tx.processed_at ?? tx.created_at));
    event.dedupeKey += `:${txId}`;
    event.factKey = `refund.transaction:${source.id}:${txId}`;
    event.references = [...refs, { kind: "REFUND_TRANSACTION", id: txId }];
    event.resourceUpdatedAt = created.resourceUpdatedAt;
    const amounts = tx.amount_set ? moneyProperties(tx.amount_set) : money(tx.amount, tx.currency);
    event.properties = { ...(amounts ?? {}), test: typeof tx.test === "boolean" ? tx.test : null, occurredAtBasis: tx.processed_at ? "transaction.processed_at" : "transaction.created_at" };
    event.quarantineReason = created.quarantineReason ?? (!amounts ? "INCOMPLETE_MONEY" : undefined);
    events.push(event);
  }
  return events;
}

export function verifyProviderReceipt(source: AdapterSource, credentials: SourceCredentials, headers: Headers, raw: string, now: Date): ProviderReceipt {
  verifySignature(source, credentials, headers, raw, now);
  const body = parse(raw);
  const rawPayloadDigest = digest(raw);
  if (source.provider === "CALENDLY") {
    const payload = object(body.payload);
    return { rawPayloadDigest, events: [normalizeBooking(source, payload, object(payload.scheduled_event), string(body.event), "HMAC", "calendly:webhook:v1")] };
  }
  shopDomain(source);
  if (headers.get("X-Shopify-Shop-Domain") !== source.externalAccountId)
    fail("TRACKING_PROVIDER_ACCOUNT_MISMATCH", 403, "The Shopify shop header does not match this source.");
  const topic = string(headers.get("X-Shopify-Topic"), 128);
  const deliveryId = string(headers.get("X-Shopify-Webhook-Id"), 256);
  const apiVersion = string(headers.get("X-Shopify-API-Version"), 32);
  if (apiVersion !== API_VERSION) fail("TRACKING_UNSUPPORTED_API_VERSION", 400, "The provider API version is unsupported.");
  // These headers are routing/correlation hints, not cryptographically signed claims.
  const context: ReceiptContext = { topic, key: `shopify:webhook:v1:${topic}:${deliveryId}`, verification: "HMAC", deliveryId, eventId: optionalString(headers.get("X-Shopify-Event-Id"), 256), apiVersion };
  if (topic === "orders/paid") return { rawPayloadDigest, events: [normalizeOrder(source, body, context)] };
  if (topic === "refunds/create") return { rawPayloadDigest, events: normalizeRefund(source, body, context) };
  invalid("This provider topic is unsupported.");
}

async function readApi(url: string, init: RequestInit, fetcher: typeof fetch): Promise<{ body: ObjectValue; raw: string }> {
  let response: Response;
  try { response = await fetcher(url, { ...init, redirect: "error", cache: "no-store" }); }
  catch { return fail("TRACKING_PROVIDER_UNAVAILABLE", 502, "The provider request failed or timed out."); }
  if (response.redirected || (response.status >= 300 && response.status < 400)) fail("TRACKING_PROVIDER_REDIRECT", 502, "The provider returned an unexpected redirect.");
  if (response.status === 401 || response.status === 403) fail("TRACKING_PROVIDER_AUTH_REQUIRED", 409, "The provider credentials or permissions need attention.");
  if (response.status === 404) fail("TRACKING_PROVIDER_RESOURCE_NOT_FOUND", 404, "The provider resource was not found.");
  if (response.status === 429) fail("TRACKING_PROVIDER_RATE_LIMITED", 503, "The provider temporarily limited requests.");
  if (!response.ok) fail("TRACKING_PROVIDER_UNAVAILABLE", 502, "The provider request failed.");
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) invalid("The provider returned an invalid response format.");
  if (Number(response.headers.get("content-length")) > MAX_BYTES) fail("TRACKING_PAYLOAD_TOO_LARGE", 502, "The provider response is too large.");
  const reader = response.body?.getReader();
  if (!reader) invalid("The provider returned an empty response.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BYTES) {
        void reader.cancel().catch(() => {});
        fail("TRACKING_PAYLOAD_TOO_LARGE", 502, "The provider response is too large.");
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "TRACKING_PAYLOAD_TOO_LARGE") throw error;
    return fail("TRACKING_PROVIDER_UNAVAILABLE", 502, "The provider response failed or timed out.");
  } finally { reader.releaseLock(); }
  let raw: string;
  try { raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { return invalid("The provider returned an invalid response format."); }
  return { body: parse(raw), raw };
}

const ORDER_QUERY = `query LaunchPadOrder($id: ID!) {
  order(id: $id) {
    id legacyResourceId updatedAt displayFinancialStatus test checkoutToken
    customer { id email firstName lastName }
    totalPriceSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
  }
}`;
const REFUND_QUERY = `query LaunchPadRefund($id: ID!, $after: String) {
  refund(id: $id) {
    id legacyResourceId createdAt updatedAt processedAt order { id test }
    transactions(first: 100, after: $after) {
      nodes { id kind status test createdAt processedAt order { id }
        amountSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
function apiMoneyBag(value: unknown): unknown {
  if (!value) return undefined;
  const bag = object(value);
  const shop = object(bag.shopMoney), presentment = object(bag.presentmentMoney);
  return { shop_money: { amount: shop.amount, currency_code: shop.currencyCode }, presentment_money: { amount: presentment.amount, currency_code: presentment.currencyCode } };
}
async function shopQuery(source: AdapterSource, token: string, query: string, variables: Record<string, string | null>, signal: AbortSignal, fetcher: typeof fetch) {
  const result = await readApi(`https://${shopDomain(source)}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }), signal,
  }, fetcher);
  if (Array.isArray(result.body.errors)) {
    const codes = result.body.errors.map(error => {
      const extensions = object(error).extensions;
      return extensions ? object(extensions).code : undefined;
    });
    if (codes.includes("ACCESS_DENIED")) fail("TRACKING_PROVIDER_AUTH_REQUIRED", 409, "The provider credentials or protected customer data permissions need attention.");
    if (codes.includes("THROTTLED")) fail("TRACKING_PROVIDER_RATE_LIMITED", 503, "The provider temporarily limited requests.");
  }
  if (result.body.errors !== undefined && (!Array.isArray(result.body.errors) || result.body.errors.length > 0))
    fail("TRACKING_PROVIDER_GRAPHQL_ERROR", 502, "The provider could not complete the resource query.");
  return { data: object(result.body.data), raw: result.raw };
}

export async function reconcileProviderResource(source: AdapterSource, credentials: SourceCredentials, resource: ReconcileResource, now: Date, fetcher: typeof fetch = fetch): Promise<ProviderReceipt> {
  if (source.environment === "TEST" && fetcher === globalThis.fetch)
    fail("TRACKING_TEST_OUTBOUND_FORBIDDEN", 409, "Test sources require an explicitly supplied test transport.");
  if (!credentials.apiToken) fail("TRACKING_MISSING_CREDENTIALS", 409, "Provider API credentials are required.");
  if (!Number.isFinite(now.getTime())) invalid("The reconciliation time is invalid.");
  const signal = AbortSignal.timeout(10_000);
  if (source.provider === "CALENDLY" && resource.kind === "BOOKING") {
    const uri = calendlyUri(resource.id, "invitees");
    calendlyUri(source.externalAccountId, "users");
    const eventUri = uri.split("/invitees/")[0];
    const init = { headers: { Authorization: `Bearer ${credentials.apiToken}`, Accept: "application/json" }, signal };
    const invitee = await readApi(`${CALENDLY_ORIGIN}${new URL(uri).pathname}`, init, fetcher);
    const payload = object(invitee.body.resource);
    if (payload.uri !== uri || payload.event !== eventUri) invalid("The Calendly resource identities do not match.");
    const event = await readApi(`${CALENDLY_ORIGIN}${new URL(eventUri).pathname}`, init, fetcher);
    const rawPayloadDigest = digest(JSON.stringify([invitee.raw, event.raw]));
    const topic = payload.status === "active" ? "invitee.created" : payload.status === "canceled" ? "invitee.canceled" : invalid("The Calendly booking status is unsupported.");
    return { rawPayloadDigest, events: [normalizeBooking(source, payload, object(event.body.resource), topic, "API", `calendly:api:v1:${rawPayloadDigest}`)] };
  }
  if (source.provider === "SHOPIFY" && resource.kind === "ORDER") {
    const id = shopId(resource.id, "Order");
    const result = await shopQuery(source, credentials.apiToken, ORDER_QUERY, { id }, signal, fetcher);
    if (result.data.order === null) fail("TRACKING_PROVIDER_RESOURCE_NOT_FOUND", 404, "The provider resource was not found.");
    const order = object(result.data.order);
    if (order.id !== id || (order.legacyResourceId !== undefined && shopId(order.legacyResourceId, "Order") !== id)) invalid("The Shopify resource identities do not match.");
    const rawPayloadDigest = digest(result.raw);
    const context: ReceiptContext = { topic: "api/order", key: `shopify:api:v1:${rawPayloadDigest}`, verification: "API", apiVersion: API_VERSION };
    const customer = order.customer ? object(order.customer) : undefined;
    return { rawPayloadDigest, events: [normalizeOrder(source, {
      id, updated_at: order.updatedAt, financial_status: string(order.displayFinancialStatus).toLowerCase(), test: order.test,
      checkout_token: order.checkoutToken, total_price_set: apiMoneyBag(order.totalPriceSet),
      customer: customer ? { id: customer.id, email: customer.email, first_name: customer.firstName, last_name: customer.lastName } : undefined,
    }, context)] };
  }
  if (source.provider === "SHOPIFY" && resource.kind === "REFUND") {
    const id = shopId(resource.id, "Refund");
    let after: string | null = null;
    let first: ObjectValue | undefined;
    const transactions: ObjectValue[] = [], raws: string[] = [], cursors = new Set<string>();
    for (let page = 0; page < 10; page++) {
      const result = await shopQuery(source, credentials.apiToken, REFUND_QUERY, { id, after }, signal, fetcher);
      if (result.data.refund === null) fail("TRACKING_PROVIDER_RESOURCE_NOT_FOUND", 404, "The provider resource was not found.");
      const refund = object(result.data.refund), order = object(refund.order);
      if (refund.id !== id || (refund.legacyResourceId !== undefined && shopId(refund.legacyResourceId, "Refund") !== id)) invalid("The Shopify resource identities do not match.");
      if (first && (refund.updatedAt !== first.updatedAt || order.id !== object(first.order).id || order.test !== object(first.order).test))
        fail("TRACKING_INCOMPLETE_RECONCILIATION", 502, "The provider resource changed during reconciliation.");
      first ??= refund;
      raws.push(result.raw);
      const connection = object(refund.transactions);
      if (!Array.isArray(connection.nodes) || connection.nodes.length > 100) invalid();
      transactions.push(...connection.nodes.map(node => {
        const tx = object(node);
        return {
          id: tx.id, order_id: object(tx.order).id, kind: string(tx.kind).toLowerCase(), status: string(tx.status).toLowerCase(), test: tx.test,
          created_at: tx.createdAt, processed_at: tx.processedAt, amount_set: apiMoneyBag(tx.amountSet),
        };
      }));
      const pageInfo = object(connection.pageInfo);
      if (typeof pageInfo.hasNextPage !== "boolean") invalid();
      if (!pageInfo.hasNextPage) {
        const rawPayloadDigest = digest(JSON.stringify(raws));
        const context: ReceiptContext = { topic: "api/refund", key: `shopify:api:v1:${rawPayloadDigest}`, verification: "API", apiVersion: API_VERSION };
        return { rawPayloadDigest, events: normalizeRefund(source, {
          id, order_id: order.id, order_test: order.test, created_at: first.createdAt, updated_at: first.updatedAt, transactions,
        }, context) };
      }
      after = string(pageInfo.endCursor, 2048);
      if (cursors.has(after)) fail("TRACKING_INCOMPLETE_RECONCILIATION", 502, "The provider repeated a reconciliation cursor.");
      cursors.add(after);
    }
    fail("TRACKING_INCOMPLETE_RECONCILIATION", 502, "The provider reconciliation exceeded its page limit.");
  }
  fail("TRACKING_UNSUPPORTED_RESOURCE", 400, "This source does not support reconciliation of that resource.");
}
