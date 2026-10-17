import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { verifyProviderReceipt, reconcileProviderResource } from "../../apps/web/src/server/funnels/providerTracking";
import type { AdapterSource } from "../../apps/web/src/server/funnels/trackingTypes";

const now = new Date("2026-10-17T12:00:00.000Z");
const secret = "fixture-signing-secret";
const calendly: AdapterSource = {
  id: "cal-source", ownerId: "owner-a", provider: "CALENDLY", environment: "TEST",
  externalAccountId: "https://api.calendly.com/users/host-a",
  config: { allowedOrigins: [], allowedEvents: [], propertyKeys: [], correlationField: "utm_content" },
};
const shopify: AdapterSource = {
  ...calendly, id: "shop-source", provider: "SHOPIFY", externalAccountId: "fixture-shop.myshopify.com",
};
const eventUri = "https://api.calendly.com/scheduled_events/event-a";
const inviteeUri = `${eventUri}/invitees/invitee-a`;
const booking = () => ({
  event: "invitee.created", created_at: "2026-10-17T11:59:00.000Z",
  payload: {
    uri: inviteeUri, event: eventUri, status: "active", created_at: "2026-10-17T11:58:00.000Z",
    updated_at: "2026-10-17T11:58:00.000Z", email: "person@example.test", name: "A Person",
    rescheduled: false, old_invitee: null as string | null, new_invitee: null as string | null,
    tracking: { utm_content: "opaque-launchpad-correlation" },
    scheduled_event: { uri: eventUri, status: "active", event_memberships: [{ user: calendly.externalAccountId }] },
  },
});
function signedCalendly(raw: string, timestamp = String(now.getTime() / 1000)) {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
  return new Headers({ "Calendly-Webhook-Signature": `t=${timestamp},v1=${signature}` });
}
function signedShopify(raw: string, topic = "orders/paid") {
  return new Headers({
    "X-Shopify-Hmac-SHA256": createHmac("sha256", secret).update(raw).digest("base64"),
    "X-Shopify-Topic": topic, "X-Shopify-Shop-Domain": shopify.externalAccountId,
    "X-Shopify-Webhook-Id": "delivery-a", "X-Shopify-Event-Id": "merchant-event-a",
    "X-Shopify-API-Version": "2026-10", "X-Shopify-Triggered-At": "2026-10-17T11:59:00Z",
  });
}

test("a signed booking is linked to its host and carries explicit correlation without inventing a sales subject", () => {
  const raw = JSON.stringify(booking());
  const receipt = verifyProviderReceipt(calendly, { signingSecret: secret }, signedCalendly(raw), raw, now);
  assert.equal(receipt.events.length, 1);
  const event = receipt.events[0];
  assert.equal(event.type, "booking.confirmed");
  assert.deepEqual(event.resource, { kind: "BOOKING", id: inviteeUri });
  assert.equal(event.correlationToken, "opaque-launchpad-correlation");
  assert.equal(event.correlationEmail, "person@example.test");
  assert.equal(event.createsSubject, undefined);
  assert.equal(event.authority, "PROVIDER_VERIFIED");
  assert.equal(event.verification, "HMAC");
  assert.equal(event.quarantineReason, undefined);
});

const orderId = "820982911946154508";
const orderGid = `gid://shopify/Order/${orderId}`;
function paidOrder() {
  return `{"id":${orderId},"admin_graphql_api_id":"${orderGid}","financial_status":"paid","test":true,"updated_at":"2026-10-17T11:59:00Z","checkout_token":"checkout-a","customer":null,"total_price_set":{"shop_money":{"amount":"120.50","currency_code":"GBP"},"presentment_money":{"amount":"150.25","currency_code":"USD"}}}`;
}
test("paid orders preserve large business IDs, separate currencies and checkout identity", () => {
  const raw = paidOrder();
  const [event] = verifyProviderReceipt(shopify, { signingSecret: secret }, signedShopify(raw), raw, now).events;
  assert.equal(event.type, "order.paid");
  assert.deepEqual(event.resource, { kind: "ORDER", id: orderGid });
  assert.equal(event.factKey, "order.paid");
  assert.equal(event.createsSubject, true);
  assert.equal(event.subjectKind, "PURCHASE");
  assert.equal(event.properties.amount, "120.50");
  assert.equal(event.properties.currency, "GBP");
  assert.equal(event.properties.presentmentAmount, "150.25");
  assert.equal(event.properties.presentmentCurrency, "USD");
  assert.ok(event.references.some(ref => ref.kind === "CHECKOUT" && ref.id === "checkout-a"));
  assert.equal(event.providerDeliveryId, "delivery-a");
  assert.equal(event.providerEventId, "merchant-event-a");
  assert.equal(event.quarantineReason, undefined);
});

function refundBody() {
  return {
    id: "890088186047892319", admin_graphql_api_id: "gid://shopify/Refund/890088186047892319", order_id: orderId,
    created_at: "2026-10-17T11:57:00Z", processed_at: "2026-10-17T11:58:00Z",
    transactions: [
      { id: "245135271310201194", order_id: orderId, kind: "refund", status: "success", test: true, amount: "25.00", currency: "GBP" as string | null, created_at: "2026-10-17T11:57:00Z", processed_at: "2026-10-17T11:58:00Z" },
      { id: "245135271310201195", order_id: orderId, kind: "refund", status: "pending", test: true, amount: "10.00", currency: "GBP", created_at: "2026-10-17T11:57:00Z", processed_at: null },
    ],
  };
}
test("refund creation records only successful refund transactions as distinct monetary facts", () => {
  const raw = JSON.stringify(refundBody());
  const events = verifyProviderReceipt(shopify, { signingSecret: secret }, signedShopify(raw, "refunds/create"), raw, now).events;
  assert.deepEqual(events.map(event => event.type), ["refund.created", "refund.succeeded"]);
  assert.equal(events[1].factKey, "refund.transaction:shop-source:gid://shopify/OrderTransaction/245135271310201194");
  assert.deepEqual(events[1].resource, { kind: "ORDER", id: orderGid });
  assert.equal(events[1].properties.amount, "25.00");
  assert.equal(events[1].properties.currency, "GBP");
  assert.equal(events[1].createsSubject, undefined);
  assert.equal(events[1].quarantineReason, undefined);
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
test("known booking reconciliation authenticates fixed endpoints and preserves the webhook business fact", async () => {
  const calls: string[] = [];
  const sample = booking();
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input); calls.push(url);
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture-api-token");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal instanceof AbortSignal);
    if (url === inviteeUri) return jsonResponse({ resource: sample.payload });
    if (url === eventUri) return jsonResponse({ resource: sample.payload.scheduled_event });
    throw new Error("Unexpected protocol endpoint");
  };
  const api = await reconcileProviderResource(calendly, { apiToken: "fixture-api-token" }, { kind: "BOOKING", id: inviteeUri }, now, fetcher);
  const raw = JSON.stringify(sample);
  const webhook = verifyProviderReceipt(calendly, { signingSecret: secret }, signedCalendly(raw), raw, now);
  assert.equal(api.events[0].factKey, webhook.events[0].factKey);
  assert.notEqual(api.events[0].dedupeKey, webhook.events[0].dedupeKey);
  assert.equal(api.events[0].verification, "API");
  assert.deepEqual(calls, [inviteeUri, eventUri]);
  await assert.rejects(reconcileProviderResource(calendly, { apiToken: "fixture-api-token" }, { kind: "BOOKING", id: inviteeUri }, now), { code: "TRACKING_TEST_OUTBOUND_FORBIDDEN" });
});

const apiMoney = { shopMoney: { amount: "120.50", currencyCode: "GBP" }, presentmentMoney: { amount: "150.25", currencyCode: "USD" } };
test("known order reconciliation uses the registered shop and fixed GraphQL version with the same purchase fact", async () => {
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(String(input), "https://fixture-shop.myshopify.com/admin/api/2026-10/graphql.json");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("X-Shopify-Access-Token"), "fixture-api-token");
    const request = JSON.parse(String(init?.body));
    assert.deepEqual(request.variables, { id: orderGid });
    assert.match(request.query, /checkoutToken/);
    return jsonResponse({ data: { order: { id: orderGid, legacyResourceId: orderId, updatedAt: "2026-10-17T11:59:00Z", displayFinancialStatus: "PAID", test: true, checkoutToken: "checkout-a", totalPriceSet: apiMoney } } });
  };
  const [event] = (await reconcileProviderResource(shopify, { apiToken: "fixture-api-token" }, { kind: "ORDER", id: orderId }, now, fetcher)).events;
  assert.equal(event.type, "order.paid");
  assert.equal(event.factKey, "order.paid");
  assert.equal(event.resource.id, orderGid);
  assert.equal(event.verification, "API");
  assert.equal(event.quarantineReason, undefined);
});

const refundGid = "gid://shopify/Refund/890088186047892319";
function refundPage(after: string | null, hasNextPage = after === null) {
  const txId = after === null ? "245135271310201195" : "245135271310201194";
  return { data: { refund: {
    id: refundGid, legacyResourceId: "890088186047892319", createdAt: "2026-10-17T11:57:00Z",
    updatedAt: "2026-10-17T11:59:00Z", order: { id: orderGid, test: true },
    transactions: { nodes: [{ id: `gid://shopify/OrderTransaction/${txId}`, kind: "REFUND", status: after === null ? "PENDING" : "SUCCESS", test: true,
      order: { id: orderGid }, createdAt: "2026-10-17T11:57:00Z", processedAt: after === null ? null : "2026-10-17T11:58:00Z", amountSet: apiMoney,
    }], pageInfo: { hasNextPage, endCursor: after === null ? "page-two" : "page-three" } },
  } } };
}
test("refund reconciliation follows bounded transaction cursors and discovers success on a later page", async () => {
  const cursors: Array<string | null> = [];
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(String(input), "https://fixture-shop.myshopify.com/admin/api/2026-10/graphql.json");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.variables.id, refundGid);
    assert.match(body.query, /transactions\(first: 100, after: \$after\)/);
    cursors.push(body.variables.after);
    return jsonResponse(refundPage(body.variables.after));
  };
  const events = (await reconcileProviderResource(shopify, { apiToken: "fixture-api-token" }, { kind: "REFUND", id: refundGid }, now, fetcher)).events;
  assert.deepEqual(cursors, [null, "page-two"]);
  assert.deepEqual(events.map(event => event.type), ["refund.created", "refund.succeeded"]);
  assert.equal(events[1].factKey, "refund.transaction:shop-source:gid://shopify/OrderTransaction/245135271310201194");
  assert.equal(events[1].properties.currency, "GBP");
  assert.equal(events[1].properties.presentmentCurrency, "USD");
});

test("Calendly rejects tampering, malformed signatures and replay timestamps before parsing payloads", () => {
  const raw = JSON.stringify(booking());
  for (const headers of [
    new Headers(),
    signedCalendly(raw, String(now.getTime() / 1000 - 181)),
    signedCalendly(raw, String(now.getTime() / 1000 + 181)),
    new Headers({ "Calendly-Webhook-Signature": `${signedCalendly(raw).get("Calendly-Webhook-Signature")},t=1` }),
    new Headers({ "Calendly-Webhook-Signature": "t=invalid,v1=bad" }),
  ]) assert.throws(() => verifyProviderReceipt(calendly, { signingSecret: secret }, headers, raw, now), { code: "TRACKING_INVALID_SIGNATURE" });
  assert.throws(() => verifyProviderReceipt(calendly, { signingSecret: secret }, signedCalendly(raw), raw + " ", now), { code: "TRACKING_INVALID_SIGNATURE" });
  assert.throws(() => verifyProviderReceipt(calendly, { signingSecret: secret }, signedCalendly(raw), "{invalid", now), { code: "TRACKING_INVALID_SIGNATURE" });
});

test("rescheduled bookings share only explicit invitee links while group invitees stay distinct", () => {
  const previous = `${eventUri}/invitees/old-invitee`;
  const sample = booking();
  sample.payload.old_invitee = previous;
  sample.payload.rescheduled = true;
  let raw = JSON.stringify(sample);
  const created = verifyProviderReceipt(calendly, { signingSecret: secret }, signedCalendly(raw), raw, now).events[0];
  assert.deepEqual(created.references.filter(ref => ref.kind === "BOOKING"), [{ kind: "BOOKING", id: previous }]);
  const canceled = { ...sample, event: "invitee.canceled", payload: { ...sample.payload, uri: previous, status: "canceled", old_invitee: null, new_invitee: inviteeUri, cancellation: { created_at: "2026-10-17T11:59:30Z" } } };
  raw = JSON.stringify(canceled);
  const cancelled = verifyProviderReceipt(calendly, { signingSecret: secret }, signedCalendly(raw), raw, now).events[0];
  assert.equal(cancelled.type, "booking.cancelled");
  assert.equal(cancelled.occurredAt, "2026-10-17T11:59:30.000Z");
  assert.deepEqual(cancelled.references.filter(ref => ref.kind === "BOOKING"), [{ kind: "BOOKING", id: inviteeUri }]);
  const group = booking(); group.payload.uri = `${eventUri}/invitees/group-invitee`;
  raw = JSON.stringify(group);
  const groupEvent = verifyProviderReceipt(calendly, { signingSecret: secret }, signedCalendly(raw), raw, now).events[0];
  assert.notEqual(groupEvent.factKey, created.factKey);
  assert.equal(groupEvent.references.some(ref => ref.kind === "BOOKING"), false);
});

test("Calendly enforces source host and resource identity without treating email as ownership", () => {
  for (const change of [
    (body: ReturnType<typeof booking>) => { body.payload.scheduled_event.event_memberships = [{ user: "https://api.calendly.com/users/other-host" }]; },
    (body: ReturnType<typeof booking>) => { body.payload.uri = "https://attacker.test/invitees/person"; },
    (body: ReturnType<typeof booking>) => { body.payload.event = "https://api.calendly.com/scheduled_events/other-event"; },
  ]) {
    const body = booking(); change(body); const raw = JSON.stringify(body);
    assert.throws(() => verifyProviderReceipt(calendly, { signingSecret: secret }, signedCalendly(raw), raw, now));
  }
  const body = booking(); delete (body.payload as Partial<typeof body.payload>).tracking;
  const raw = JSON.stringify(body);
  const event = verifyProviderReceipt(calendly, { signingSecret: secret }, signedCalendly(raw), raw, now).events[0];
  assert.equal(event.correlationToken, undefined);
  assert.equal(event.contactIdentity, undefined);
  assert.equal(event.createsSubject, undefined);
});

test("Shopify verifies the exact raw body and does not trust header timestamps or merchant identity", () => {
  const raw = paidOrder();
  for (const value of ["", "bad", "A".repeat(43) + "=", "A".repeat(44)]) {
    const headers = signedShopify(raw); headers.set("X-Shopify-Hmac-SHA256", value);
    assert.throws(() => verifyProviderReceipt(shopify, { signingSecret: secret }, headers, raw, now), { code: "TRACKING_INVALID_SIGNATURE" });
  }
  assert.throws(() => verifyProviderReceipt(shopify, { signingSecret: secret }, signedShopify(raw), raw + " ", now), { code: "TRACKING_INVALID_SIGNATURE" });
  const forged = signedShopify(raw); forged.set("X-Shopify-Shop-Domain", "another-shop.myshopify.com");
  assert.throws(() => verifyProviderReceipt(shopify, { signingSecret: secret }, forged, raw, now), { code: "TRACKING_PROVIDER_ACCOUNT_MISMATCH" });
  const headers = signedShopify(raw); headers.set("X-Shopify-Triggered-At", "2099-01-01T00:00:00Z"); headers.set("X-Shopify-Webhook-Id", "another-delivery");
  const event = verifyProviderReceipt(shopify, { signingSecret: secret }, headers, raw, now).events[0];
  assert.equal(event.occurredAt, "2026-10-17T11:59:00.000Z");
  assert.equal(event.factKey, "order.paid");
  assert.equal(event.resource.id, orderGid);
});

test("paid-order inconsistencies are quarantined and no currency is fabricated", () => {
  for (const [raw, reason] of [
    [paidOrder().replace('"financial_status":"paid"', '"financial_status":"voided"'), "INCOHERENT_PAID_STATUS"],
    [paidOrder().replace('"test":true', '"test":false'), "PROVIDER_MODE_MISMATCH"],
    [paidOrder().replace('"currency_code":"GBP"', '"currency_code":null'), "INCOMPLETE_MONEY"],
  ]) {
    const event = verifyProviderReceipt(shopify, { signingSecret: secret }, signedShopify(raw), raw, now).events[0];
    assert.equal(event.quarantineReason, reason);
    if (reason === "INCOMPLETE_MONEY") assert.equal(event.properties.currency, undefined);
  }
  const mismatched = paidOrder().replace(`"${orderGid}"`, '"gid://shopify/Order/123"');
  assert.throws(() => verifyProviderReceipt(shopify, { signingSecret: secret }, signedShopify(mismatched), mismatched, now), { code: "TRACKING_INVALID_PROVIDER_PAYLOAD" });
});

test("pending, failed and suggested refunds never become successful monetary facts", () => {
  for (const status of ["pending", "awaiting_response", "failure", "error", "unknown"]) {
    const body = refundBody(); body.transactions[0].status = status;
    const raw = JSON.stringify(body);
    assert.deepEqual(verifyProviderReceipt(shopify, { signingSecret: secret }, signedShopify(raw, "refunds/create"), raw, now).events.map(event => event.type), ["refund.created"]);
  }
  const body = refundBody(); body.transactions[0].kind = "suggested_refund";
  let raw = JSON.stringify(body);
  assert.equal(verifyProviderReceipt(shopify, { signingSecret: secret }, signedShopify(raw, "refunds/create"), raw, now).events.length, 1);
  body.transactions[0].kind = "refund"; body.transactions[0].currency = null;
  raw = JSON.stringify(body);
  const event = verifyProviderReceipt(shopify, { signingSecret: secret }, signedShopify(raw, "refunds/create"), raw, now).events[1];
  assert.equal(event.quarantineReason, "INCOMPLETE_MONEY");
  assert.equal(event.properties.currency, undefined);
});

test("known-resource reconciliation refuses attacker URLs and unsupported account forms before transport", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; throw new Error("No request should be made"); };
  for (const id of ["http://127.0.0.1/secret", `${inviteeUri}?token=secret`, `${inviteeUri}/extra`, "https://api.calendly.com@attacker.test/scheduled_events/a/invitees/b", "https://api.calendly.com/scheduled_events/a/invitees/%2e%2e"]) {
    await assert.rejects(reconcileProviderResource(calendly, { apiToken: "fixture-api-token" }, { kind: "BOOKING", id }, now, fetcher), { code: "TRACKING_INVALID_PROVIDER_PAYLOAD" });
  }
  for (const externalAccountId of ["fixture-shop.myshopify.com.attacker.test", "https://fixture-shop.myshopify.com", "localhost", "fixture-shop.myshopify.com:443"]) {
    await assert.rejects(reconcileProviderResource({ ...shopify, externalAccountId }, { apiToken: "fixture-api-token" }, { kind: "ORDER", id: orderId }, now, fetcher), { code: "TRACKING_INVALID_SOURCE" });
  }
  assert.equal(calls, 0);
  await assert.rejects(reconcileProviderResource(shopify, { apiToken: "fixture-api-token" }, { kind: "ORDER", id: orderId }, now), { code: "TRACKING_TEST_OUTBOUND_FORBIDDEN" });
});

test("provider errors never become a cancellation, paid fact or leaked provider diagnostic", async () => {
  for (const [status, code] of [[401, "TRACKING_PROVIDER_AUTH_REQUIRED"], [403, "TRACKING_PROVIDER_AUTH_REQUIRED"], [404, "TRACKING_PROVIDER_RESOURCE_NOT_FOUND"], [429, "TRACKING_PROVIDER_RATE_LIMITED"], [500, "TRACKING_PROVIDER_UNAVAILABLE"], [302, "TRACKING_PROVIDER_REDIRECT"]] as const) {
    const fetcher: typeof fetch = async () => jsonResponse({ secret: "fixture-upstream-secret" }, status);
    await assert.rejects(reconcileProviderResource(shopify, { apiToken: "fixture-api-token" }, { kind: "ORDER", id: orderId }, now, fetcher), error => {
      assert.equal((error as { code: string }).code, code);
      assert.doesNotMatch(String(error), /fixture-upstream-secret|fixture-api-token/);
      return true;
    });
  }
  for (const body of [{ errors: [{ message: "fixture-upstream-secret" }], data: { order: null } }, { data: { order: null } }]) {
    const fetcher: typeof fetch = async () => jsonResponse(body);
    await assert.rejects(reconcileProviderResource(shopify, { apiToken: "fixture-api-token" }, { kind: "ORDER", id: orderId }, now, fetcher), error => {
      assert.doesNotMatch(String(error), /fixture-upstream-secret/);
      assert.ok(["TRACKING_PROVIDER_GRAPHQL_ERROR", "TRACKING_PROVIDER_RESOURCE_NOT_FOUND"].includes((error as { code: string }).code));
      return true;
    });
  }
});

test("bounded API bodies reject oversized headers and chunked responses without returning partial facts", async () => {
  for (const fetcher of [
    (async () => new Response("{}", { headers: { "Content-Type": "application/json", "Content-Length": "1048577" } })) as typeof fetch,
    (async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(700_000)); controller.enqueue(new Uint8Array(700_000)); controller.close(); } }), { headers: { "Content-Type": "application/json" } })) as typeof fetch,
  ]) {
    await assert.rejects(reconcileProviderResource(shopify, { apiToken: "fixture-api-token" }, { kind: "ORDER", id: orderId }, now, fetcher), { code: "TRACKING_PAYLOAD_TOO_LARGE" });
  }
});

test("refund pagination rejects repeated cursors, changed resources and unbounded continuation", async () => {
  for (const behavior of ["repeat", "changed", "unbounded"] as const) {
    let requests = 0;
    const fetcher: typeof fetch = async (_input, init) => {
      requests++;
      const after = JSON.parse(String(init?.body)).variables.after;
      const body = refundPage(after, true);
      body.data.refund.transactions.nodes = [];
      body.data.refund.transactions.pageInfo.endCursor = behavior === "repeat" ? "same-cursor" : `cursor-${requests}`;
      if (behavior === "changed" && requests > 1) body.data.refund.updatedAt = "2026-10-17T12:00:00Z";
      return jsonResponse(body);
    };
    await assert.rejects(reconcileProviderResource(shopify, { apiToken: "fixture-api-token" }, { kind: "REFUND", id: refundGid }, now, fetcher), { code: "TRACKING_INCOMPLETE_RECONCILIATION" });
    assert.equal(requests, behavior === "unbounded" ? 10 : 2);
  }
});

test("refunds with inconsistent order or environment cannot produce actionable success", () => {
  for (const update of [
    (body: ReturnType<typeof refundBody>) => { body.transactions[1].test = false; },
    (body: ReturnType<typeof refundBody>) => { body.transactions[0].order_id = "123"; },
  ]) {
    const body = refundBody(); update(body); const raw = JSON.stringify(body);
    const events = verifyProviderReceipt(shopify, { signingSecret: secret }, signedShopify(raw, "refunds/create"), raw, now).events;
    assert.ok(events.every(event => event.quarantineReason));
  }
});

test("repeat purchases share verified customer identity while their order subjects remain separate", () => {
  const first = JSON.parse(paidOrder().replace(`"id":${orderId}`, `"id":"${orderId}"`));
  first.customer = { id: "9007199254740993", email: "buyer@example.test", first_name: "Ada", last_name: "Lovelace" };
  const second = { ...first, id: "820982911946154509", admin_graphql_api_id: "gid://shopify/Order/820982911946154509" };
  const events = [first, second].map(body => {
    const raw = JSON.stringify(body);
    return verifyProviderReceipt(shopify, { signingSecret: secret }, signedShopify(raw), raw, now).events[0];
  });
  assert.deepEqual(events[0].contactIdentity, { kind: "CUSTOMER", id: "gid://shopify/Customer/9007199254740993" });
  assert.deepEqual(events[1].contactIdentity, events[0].contactIdentity);
  assert.deepEqual(events[0].contact, { email: "buyer@example.test", name: "Ada Lovelace" });
  assert.notEqual(events[0].resource.id, events[1].resource.id);
  assert.ok(events.every(event => !event.references.some(ref => ref.kind === "CUSTOMER")));
  first.customer = { id: "9007199254740993", email: null, first_name: null, last_name: null };
  const raw = JSON.stringify(first);
  const anonymous = verifyProviderReceipt(shopify, { signingSecret: secret }, signedShopify(raw), raw, now).events[0];
  assert.deepEqual(anonymous.contactIdentity, events[0].contactIdentity);
  assert.equal(anonymous.contact, undefined);
});

test("customer API permission failures require recovery instead of silently losing contact identity", async () => {
  const fetcher: typeof fetch = async () => jsonResponse({
    data: { order: { id: orderGid, customer: null } },
    errors: [{ message: "fixture-protected-customer-diagnostic", extensions: { code: "ACCESS_DENIED" } }],
  });
  await assert.rejects(reconcileProviderResource(shopify, { apiToken: "fixture-api-token" }, { kind: "ORDER", id: orderId }, now, fetcher), { code: "TRACKING_PROVIDER_AUTH_REQUIRED" });
});
