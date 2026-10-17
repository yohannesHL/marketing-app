# Tracking sources and receipts

This is the operator and integration contract for issue #37. [The funnel contract](contracts.md) defines identity, evidence and replay rules. Source ingestion is available independently of the later funnel builder, campaigns and automation worker. Receiving or matching an event does not send email or execute a funnel action.

## Deploy the receipt worker

Use Node 24.16 or a later Node 24 release. Apply the repository's Prisma migrations and generate its client. The web app and receipt worker need the same explicit `DATABASE_URL`, `APP_ORIGIN`, `CONNECTION_TOKEN_KEYS` and `CONNECTION_ACTIVE_KEY_ID`. For SQLite use an absolute persistent file URL, for example `file:/srv/launchpad/data/launchpad.db`, backed by durable storage. A relative file URL can resolve differently when commands have different working directories. The worker refuses missing, in-memory or relative local file database configuration; absolute `file:` and `file://` URLs are supported, as are persistent remote URLs supported by the existing database client.

`FUNNEL_LIVE_INGRESS_ENABLED=true` enables creation and processing of LIVE sources. It defaults off and must be set consistently for both web and worker processes. TEST and LIVE records have separate identity and subject boundaries. TEST is not evidence that the real provider is connected: provider API reconciliation for a TEST source refuses the default network transport and is exercised using injected fixture transports in tests.

From the repository root:

```sh
npm run tracking:worker -- run-once
npm run tracking:worker -- run
npm run tracking:worker -- prune
```

Use a process supervisor for `run`; allow it to finish its current transaction on SIGTERM/SIGINT. It processes durable queued receipts, waits one second when idle, and emits only status codes. A crash rolls back the active matching transaction; the durable receipt remains available for the next process. There is no request-local timer or in-memory event queue. This worker does not make provider calls or send messages. Operator-initiated reconciliation uses the explicit management endpoint below.

Run `prune` from the deployment's scheduler, with the same configuration. Current pruning redacts the normalized envelopes of expired unresolved/quarantined/blocked receipts after 180 days and removes expired correlation tokens. Raw provider bodies are never stored, only their SHA-256 digests and normalized evidence. Matched evidence, canonical facts and deduplication records are retained: lifecycle-aware deletion of evidence referenced by journeys and jobs belongs to subsequent issues. Do not represent the full retention lifecycle as complete at this stage.

## Management API

All endpoints return `Cache-Control: no-store`. Every management request requires the LaunchPad customer session; every mutation also requires an exact `Origin` matching `APP_ORIGIN`. Bodies are JSON objects limited to 32 KiB. IDs are opaque and owner-scoped. Cross-owner lookups do not expose another account's records. Source secret values are returned only when created or explicitly rotated, not in list/diagnostic responses.

| Method and endpoint | Body or query | Result |
| --- | --- | --- |
| `GET /api/tracking/sources` | None | Owned source configuration and receiving/matching health; `readyForAutomation` remains false at this stage |
| `POST /api/tracking/sources` | `name`, `provider`, `environment`, `externalAccountId`, optional `config`, optional `credentials` | Source; API signing secret or provider ingress token where applicable |
| `PATCH /api/tracking/sources/:id` | `status`, complete replacement `config` or `credentials`, and/or `rotateIngress: true` | Updated source and newly rotated ingress token if requested |
| `GET /api/tracking/sources/:id/events` | Optional `cursor` from `nextCursor` | 50 safe receipt summaries and the next cursor; no raw bodies or credentials |
| `GET /api/tracking/sources/:id/audit` | None | Latest 100 audit entries |
| `GET /api/tracking/subjects` | Required `environment=TEST` or `environment=LIVE` | Latest 100 owned subject summaries |
| `POST /api/tracking/sources/:id/correlations` | `subjectId` | Short-lived opaque Calendly correlation token, field and expiry |
| `POST /api/tracking/sources/:id/reconcile` | `kind: BOOKING`, `ORDER` or `REFUND`, and provider resource `id` | Bounded provider read and durable BACKFILL receipt |
| `POST /api/tracking/sources/:id/events/:eventId/match` | `subjectId`, human-readable `reason` | Audited manual matching queued in REPLAY mode |
| `POST /api/tracking/sources/:id/events/:eventId/replay` | `{}` | History-only reprocessing; redacted/quarantined evidence is not replayable |
| `DELETE /api/tracking/contacts/:id` | None | Contact PII and linked receipt evidence redacted; identity tombstones retained to prevent recreation by delayed evidence |

Providers are `NATIVE`, `API`, `CALENDLY` and `SHOPIFY`. Environment is explicitly `TEST` or `LIVE`. Source statuses are `ACTIVE`, `PAUSED` and `DISCONNECTED`. Changing configuration, credentials or status advances a generation fence: already queued evidence is blocked until an operator reviews and explicitly replays it. PATCH credential replacement must include the complete signing configuration; omitting a previously saved API token removes it.

Example NATIVE source creation body:

```json
{
  "name": "Website enquiry form",
  "provider": "NATIVE",
  "environment": "TEST",
  "externalAccountId": "website-main",
  "config": {
    "allowedOrigins": ["https://www.example.com"],
    "allowedEvents": ["enquiry.accepted", "page.viewed", "product.viewed", "checkout.observed"],
    "propertyKeys": ["path", "referrer", "utm_source", "utm_medium", "utm_campaign", "campaign", "consent"]
  }
}
```

Only exact HTTPS origins or local development origins are supported. A wildcard domain does not grant access. `propertyKeys` permits at most 30 bounded scalar properties and rejects secret-like names. Configuration is a replacement object, not a partial merge. Do not place private form fields, full URL queries or access credentials in generic properties. Receiving an accepted form identifies the submitted enquiry; it does not verify ownership of the email address or establish permission to send marketing email.

## Website SDK and native form

Serve `/launchpad-tracking.js` from LaunchPad. Loading the script performs no collection, network request or storage access. The website must call `create` and pass explicit consent. The SDK never automatically reads the current URL, tracks page navigation or binds to forms.

```html
<script src="https://launchpad.example.com/launchpad-tracking.js"></script>
<script>
  const tracking = LaunchPadTracking.create({
    sourceId: "SOURCE_ID_FROM_SETUP",
    endpoint: "https://launchpad.example.com",
    consent: false
  });

  // Call from the site's consent manager after an explicit decision.
  async function enableMeasurement() {
    tracking.setConsent(true);
    await tracking.track("page.viewed", { path: "/pricing" });
  }

  // The form handler supplies only configured fields and keeps the event ID
  // stable when retrying the same business submission.
  async function submitEnquiry(email, name, submissionId) {
    return tracking.submit({
      eventId: submissionId,
      email,
      name,
      properties: { campaign: "autumn-enquiries" }
    });
  }

  function withdrawMeasurementConsent() {
    tracking.setConsent(false);
  }
</script>
```

Use a UUID for `submissionId`, generated once per submission with `crypto.randomUUID()`. If omitted, the SDK generates an event UUID. Calls made without consent return `{accepted:false, reason:"CONSENT_REQUIRED"}` and send nothing. The hosting form must handle that result explicitly; it must not show a successful submission if nothing was accepted. Sites requiring a form independent of optional measurement can submit the native `/form` request directly without a visitor token, with their own consent handling and required disclosures. No anonymous history is then attached.

After consent and the first explicit call, the SDK requests an anonymous visitor token and retains it only in memory and optional `sessionStorage`, scoped by source and endpoint, for up to 24 hours. It uses no cookie or localStorage and sends requests with `credentials: "omit"` and `Referrer-Policy: no-referrer`. Withdrawal aborts in-flight SDK requests and clears its local visitor state; it cannot retract a request already durably accepted by the server. Contact deletion is a separate authenticated operation.

The SDK accepts only browser observation types `page.viewed`, `product.viewed` and `checkout.observed`. Its optional `propertyKeys` must match the source configuration. Scalar properties are limited to 30 keys and strings to 1,000 characters. For explicitly supplied `path`/`referrer` properties it removes query strings and fragments. It never submits owner IDs, contact IDs, financial outcomes or arbitrary event types. Browser observations cannot prove payment, booking or conversion.

Native endpoints are:

- `POST /api/tracking/ingest/:sourceId/visitor` with `{}` returns an anonymous `visitorToken` and expiry.
- `POST /api/tracking/ingest/:sourceId/collect` accepts `schemaVersion:1`, `eventId`, optional `visitorToken`, supported `type` and configured `properties`.
- `POST /api/tracking/ingest/:sourceId/form` accepts `schemaVersion:1`, `eventId`, optional `visitorToken`, `email`, optional `name` and configured `properties`.

All require `application/json` and an exact configured Origin, with a 32 KiB body cap. Only these native paths provide CORS preflight, limited to JSON POST and `Content-Type`; no credentialed CORS is enabled. A form acknowledgement contains only accepted/receipt identifiers, never the submitted email/name. A 202 acknowledgement means the receipt was stored; inspect source diagnostics to establish that it subsequently matched. Origin restrictions control browser use; they do not authenticate arbitrary external servers. Public native endpoints are rate-limited and cannot assert authoritative commerce outcomes.

## Server API signing

An API source uses an independent signing secret, encrypted by the server keyring. Create it without a signing secret to receive a generated one once, or supply `credentials.signingSecret`. `externalAccountId` is a stable label for the producing system. Configure supported event types and property keys explicitly, including `amount` and `currency` when producing financial evidence. Custom events must use the `custom.` namespace. Keep credentials on the sending server.

Send exact UTF-8 JSON bytes to `POST /api/tracking/ingest/:sourceId/events`. Maximum body size is 32 KiB. Sign the timestamp, immutable request ID and exact serialized body:

```js
import { createHmac, randomUUID } from "node:crypto";

const requestId = randomUUID(); // Persist once with the outgoing business event.
const raw = JSON.stringify({
  schemaVersion: 1,
  type: "enquiry.accepted",
  occurredAt: new Date().toISOString(),
  resource: { kind: "ENQUIRY", id: "enquiry_123" },
  references: [],
  subjectKind: "SALES",
  contactIdentity: { kind: "CRM_CONTACT", id: "customer_456" },
  contact: { email: "maya@example.test", name: "Maya" },
  properties: { campaign: "autumn-enquiries" }
});
// On retry keep requestId and raw unchanged; update the freshness timestamp/signature.
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = createHmac("sha256", process.env.LAUNCHPAD_SOURCE_SECRET)
  .update(`${timestamp}.${requestId}.${raw}`).digest("hex");
const response = await fetch(`${process.env.LAUNCHPAD_ORIGIN}/api/tracking/ingest/${process.env.LAUNCHPAD_SOURCE_ID}/events`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-LaunchPad-Timestamp": timestamp,
    "X-LaunchPad-Id": requestId,
    "X-LaunchPad-Signature": signature
  },
  body: raw
});
if (!response.ok) throw new Error("Review the safe tracking error code before retrying.");
```

The timestamp must be within 180 seconds of server time. Request IDs are 8–128 letters, digits, hyphens or underscores; signatures are lowercase SHA-256 hex. Synchronize sender clocks. Reusing a delivery key with identical bytes returns a duplicate receipt; different bytes produce a conflict and an audit entry without overwriting the original event. A business identity (`resource`, such as an enquiry or order) is separate from a delivery identity (`X-LaunchPad-Id`). Use stable source contact identities, never email-only guessing, to associate repeat enquiries with one person. Multiple business objects still create separate subjects.

API and provider-hook endpoints expose no browser CORS. The source ID selects the owner/environment on the server; the caller cannot provide them. JSON source envelopes with extra authority, owner or contact-ID fields are rejected.

## Authenticated handoff between sources

A signing server can explicitly connect a business reference to another owned tracking source. Only entries in API `references[]` accept an optional `sourceId`; the primary `resource` and `contactIdentity` always belong to the authenticated ingress API source. Native/browser payloads cannot use this extension. The source ID is an association namespace, not proof that the provider observed the event.

For example, after native form event `form-a` has matched, submit this signed API body to connect the CRM enquiry and stable customer identity to that existing enquiry:

```json
{
  "schemaVersion": 1,
  "type": "enquiry.accepted",
  "occurredAt": "2026-10-19T10:00:02Z",
  "resource": {"kind": "ENQUIRY", "id": "crm-enquiry-a"},
  "references": [
    {"sourceId": "OWNED_NATIVE_SOURCE_ID", "kind": "ENQUIRY", "id": "form-a"}
  ],
  "subjectKind": "SALES",
  "contactIdentity": {"kind": "CRM_CONTACT", "id": "crm-person-1"},
  "contact": {"email": "maya@example.test"}
}
```

Authenticate the exact serialized body using the signing procedure above, with a real occurrence time. A later `crm-enquiry-b` carrying the same ingress-scoped `CRM_CONTACT` identity creates a second enquiry for the same contact. The handoff does not overwrite the native contact's name/email. A prebound different contact or conflicting recipient stays quarantined; equal email addresses never merge records. Establish marketing consent separately through the audited email policy API before enabling enrolment.

For commerce, submit a server-confirmed `checkout.observed` event with a stable API `CHECKOUT` resource, `subjectKind: "PURCHASE"`, and `references: [{sourceId: "OWNED_SHOPIFY_SOURCE_ID", kind: "CHECKOUT", id: "ACTUAL_CHECKOUT_TOKEN"}]`. Use the checkout token supplied by your trusted commerce integration, not an invented order or internal subject ID. The later signed Shopify paid-order payload must carry the same token to join that subject. A second checkout/order stays a different purchase even if its verified customer ID is the same. API checkout properties may retain campaign tags actually observed by that server; this is server-asserted attribution evidence. Anonymous browser product/checkout observations are not automatically joined to a purchase. Without an explicit supported association, leave them unknown rather than claiming an identified visit.

The target must be active, owned by the same customer and in the same TEST/LIVE environment. Supported target namespaces are:

| Target provider | Accepted business reference kinds |
| --- | --- |
| NATIVE | `ENQUIRY` |
| API | `CONTACT`, `ENQUIRY`, `DEAL`, `BOOKING`, `ORDER`, `CHECKOUT`, `REFUND`, `REFUND_TRANSACTION`, subject to the chosen subject kind |
| CALENDLY | `BOOKING`, using the canonical invitee URI |
| SHOPIFY | `ORDER`, `CHECKOUT`, `REFUND`, `REFUND_TRANSACTION`; use canonical `gid://shopify/Order/…`, `gid://shopify/Refund/…` and `gid://shopify/OrderTransaction/…` for those resources; checkout tokens remain strings |

Managed email sources cannot be handoff targets. All references in an event must be compatible with its subject kind; customer identity is separate from purchase references. A request allows at most ten references. Identical qualified references normalize to one binding. Authenticate before target lookup; invalid targets return a generic error without exposing another account. The server captures target generation inside the durable acceptance transaction. Clients cannot supply a generation, owner, environment, internal contact/subject ID or verification result.

Matching and history-only replay recheck every captured target generation and active status. A rotated/disconnected target leaves the old event `BLOCKED` with `REFERENCE_SOURCE_CHANGED`; replay and identical retries retain the old fence. An operator must review the association and, if still valid, issue a genuinely new signed event with a new request ID. Retrying the old receipt does not renew authority. Source-qualified deletion tombstones prevent delayed/replayed references and stable identities from recreating deleted contacts, including pending handoffs received through another API source.

All existing identity, recipient, order and canonical-money conflicts are checked before new identities or aliases are written. An audited manual match can resolve an ambiguous receipt, but cannot attach a second order from the same store to one purchase or move an already referenced financial fact to another subject. Such cases remain `ORDER_REFERENCE_CONFLICT` or `FINANCIAL_REFERENCE_CONFLICT`; correct the source evidence instead of repeatedly matching it. Conflicting monetary values remain `FINANCIAL_FACT_CONFLICT` with the original fact retained.

Source audits distinguish `API_HANDOFF_REFERENCE` (server-asserted association, safe target source/generation/kind) and `IDENTITY_BOUND` (stable ingress identity binding). Neither label upgrades an API event from `SERVER_ASSERTED` to `PROVIDER_VERIFIED`. Only the actual provider adapter's verified receipt establishes the provider event. The [integrated release evidence](release-evidence.md) exercises both handoff paths without live provider accounts.

## Provider webhook setup

Create one source per provider account and environment with `credentials.signingSecret` and optionally `credentials.apiToken` for read reconciliation. The returned `ingressToken` forms this URL:

```text
https://launchpad.example.com/api/tracking/hooks/INGRESS_TOKEN
```

Treat the per-source URL as a secret. The service stores only its hash; source lists do not reveal it. Configure ingress/proxy/access logging to redact the entire `/api/tracking/hooks/*` path and never log request bodies or authorization/signature headers. Rotating ingress requires updating the provider's subscription URL; the old path stops resolving. Rotation or disconnect also fences already queued events. A valid URL alone is insufficient: the exact raw body must pass provider signature verification. Hooks have a 1 MiB body cap and return only a receipt acknowledgement.

### Calendly

Set `externalAccountId` to the exact `https://api.calendly.com/users/USER_ID` belonging to the source. This implementation targets user-scoped subscriptions. Configure `invitee.created` and `invitee.canceled`, the per-source callback URL and matching signing key. Store the subscription's signing key as `credentials.signingSecret`; an API personal access token/OAuth access token may be saved as `credentials.apiToken` for reconciliation. Subscription eligibility and permissions depend on the Calendly account; confirm them in the actual account before rollout.

Calendly signs `timestamp + "." + rawBody` in `Calendly-Webhook-Signature`. This implementation enforces a 180-second freshness window, validates the configured user in the scheduled event membership, and uses the invitee URI as the booking identity. A reschedule produces cancellation and creation evidence, with old/new invitee references retained. It does not infer a new sale from either event. See [Calendly webhook setup](https://developer.calendly.com/docs/api-guides/receive-data-from-scheduled-events-in-real-time-with-webhook-subscriptions), [signature verification](https://developer.calendly.com/api-docs/overview/webhooks/webhook-signatures) and [reschedule payloads](https://developer.calendly.com/docs/api-guides/see-how-webhook-payloads-change-when-invitees-reschedule-events).

To associate a booking with an existing enquiry, configure `correlationField: "utm_content"` and request a correlation for an owned SALES subject with a known recipient email. Put the returned opaque token in the booking link's `utm_content`, never an email address or subject ID. The token expires after seven days and matching also checks the recipient email digest. Confirm that the actual Calendly booking page returns this field before claiming the integration matches bookings. Reused/expired/mismatched or absent evidence stays unmatched for explicit review. The opaque booking token is distinct from the webhook ingress secret.

To recover a missing booking, reconcile `{ "kind": "BOOKING", "id": "https://api.calendly.com/scheduled_events/EVENT_ID/invitees/INVITEE_ID" }`. The service fetches both invitee and scheduled event from Calendly's fixed API origin and verifies their identities and configured user.

### Shopify

Set `externalAccountId` to the canonical `store-name.myshopify.com` hostname. Use the app signing secret, save an Admin API access token for reconciliation, and subscribe to `orders/paid` and `refunds/create` using API version **2026-10** and the per-source callback URL. The adapter explicitly rejects other webhook API versions. Configure the installation's necessary order-read scopes and required customer-data access before rollout. The implementation does not install an app or grant scopes for you.

The adapter verifies `X-Shopify-Hmac-SHA256` against exact raw bytes, checks the source shop header, and preserves webhook/event IDs separately from order/refund identities. It validates test/live evidence instead of treating a test payment as live revenue. Shop and presentment amounts retain decimal strings and explicit currencies. It uses `checkout_token` when present, because checkout IDs were removed from the relevant payloads; orders without a checkout token remain valid purchases with unknown prior checkout attribution. A refund record is not proof money was returned: only successful refund transactions produce `refund.succeeded`. See [Shopify delivery verification](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries), [checkout ID removal](https://shopify.dev/changelog/posts/removed-checkout-id-from-checkouts-and-orders-webhooks), [refunds](https://shopify.dev/docs/api/admin-graphql/latest/objects/Refund) and [transactions](https://shopify.dev/docs/api/admin-graphql/latest/objects/OrderTransaction).

Reconcile an explicit order or refund using `kind: "ORDER"`/`"REFUND"` and a numeric ID string or corresponding Shopify GraphQL GID. Reads target the configured shop's versioned Admin GraphQL endpoint; redirects are forbidden. Refund pagination is bounded, incomplete or changing responses fail closed, and provider permission/rate-limit failures do not imply a missing purchase or refund. Historical access depends on the granted scopes: [Shopify access scopes](https://shopify.dev/docs/api/usage/access-scopes).

Resend delivery uses a managed tracking source and the dedicated [email connection, sender and webhook setup](email-setup.md). Its credentials and callback matching must use the email API; generic source creation/edit/reconciliation/replay does not manage Resend messages.

## Diagnostics, recovery and release evidence

Native traffic is limited to 120 requests per source per minute; API/provider traffic to 600, using durable source counters. The visitor-token request also consumes a native request. Rate limits are shared across that source's origins and callers. A 429 means retry later; preserve the original payload and delivery ID. API requests consume source quota only after signature authentication. Provider webhook requests consume quota after resolving the secret ingress URL but before HMAC verification, so someone holding that URL can consume its source budget even with an invalid signature. Keep ingress URLs secret and deploy general ingress abuse protection in addition to source counters. Do not automatically retry changed-payload conflicts.

Follow the receipt state in source diagnostics: QUEUED means persisted; MATCHED means business/identity evidence connected; UNMATCHED needs a verified reference; QUARANTINED needs evidence correction; BLOCKED means a source generation/status changed; REDACTED evidence cannot be replayed. Source health distinguishes configuration, accepted traffic and matching. A configured source with zero traffic is not demonstrated connectivity.

Manual matching requires an owned same-environment subject and a reason, writes an audit record and reprocesses in REPLAY mode. Provider reconciliation creates BACKFILL evidence; explicit replay uses REPLAY. Neither is permission for future campaigns or automation to send messages. Late events preserve occurrence and receipt times; history recovery must not move a live journey backwards or duplicate a financial fact. A browser observation or an email address alone is never enough to assign a booking or purchase to an enquiry.

Automated fixture checks establish signature, schema, idempotency, owner/environment isolation and recovery behavior. They do not establish actual provider installation, webhooks, live-domain reachability or correlation-field round trips. Before declaring a source live-ready, retain separate redacted evidence of the configured provider account/subscription, a received and matched real event, expected duplicate behavior, recovery of a deliberately missed event, and disconnect/rotation behavior. Use test bookings/orders with explicit operator authorization; do not record customer payloads or tokens in the evidence. The later end-to-end acceptance issue owns the integrated live proof and outstanding rollout gates.
