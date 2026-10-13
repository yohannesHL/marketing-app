# Google Ads connections

The connection client uses user OAuth, trusted Google userinfo identity, offline refresh, and account discovery. The automated provider checks run against a real local Mockoon HTTP server. These checks establish the request/response contract; they do not establish live Google consent, account access, production approval or campaign delivery.

## Current Google configuration

Checked against official documentation on 13 October 2026:

- REST requests use `https://googleads.googleapis.com/v25`. Google lists v25.2 as released and v26 as upcoming. Minor releases share the major version's REST path. [Version timetable](https://developers.google.com/google-ads/api/docs/sunset-dates).
- Developer tokens were sunset on 9 September 2026. Their header is optional and ignored; a future major version will reject them. Google Ads API access belongs to the Cloud project owning the OAuth client. Enable the Google Ads API and request access from that project's Google Ads API Overview page. Some generated documentation summaries and older REST examples still describe developer tokens as required; the migration page's actual policy body supersedes them. [Developer-token migration](https://developers.google.com/google-ads/api/docs/api-policy/developer-token).
- Test access covers test accounts. Explorer covers production at 2,880 operations per day and test at 15,000. Basic covers both at 15,000. Standard lifts the daily operation cap but retains service restrictions. Explorer excludes user management, account creation, planning and billing; Basic requires brand verification and Standard requires review. A successful OAuth exchange does not prove the project's production access. [Access levels](https://developers.google.com/google-ads/api/docs/api-policy/access-levels).

The server operator supplies a Web OAuth client ID, client secret and exact registered callback URI from that same Cloud project. Keep secrets in server configuration/secret storage. Use the connection API's session-bound, single-use state and PKCE verifier; do not accept a browser-provided provider subject, callback URI, provider base URL or manager-access claim.

## Authorization and refresh

`GoogleAdsClient.authorizationUrl` builds Google's fixed authorization endpoint with `openid` and `https://www.googleapis.com/auth/adwords`, `response_type=code`, offline access, consent/account selection, state and an S256 challenge. Before exchange, the callback atomically claims the foundation's state and keeps its private claim token on the server. Only that callback may complete or cancel the attempt; a duplicate request cannot cancel an exchange already in flight. Final state consumption and encrypted grant persistence share a transaction. An OAuth `error=access_denied` callback produces a declined-consent result without attempting code exchange. [Web OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [PKCE parameters](https://developers.google.com/identity/protocols/oauth2/native-app).

`exchangeCode` posts form-encoded client credentials, code, callback and verifier to `https://oauth2.googleapis.com/token`. It fetches `https://openidconnect.googleapis.com/v1/userinfo` directly with the resulting bearer token and retains `sub` as the provider identity. It never decodes an unchecked ID token or uses email as identity. Google exposes that endpoint in its discovery document; `sub` is stable across email changes. [OIDC identity](https://developers.google.com/identity/openid-connect/openid-connect), [Discovery document](https://accounts.google.com/.well-known/openid-configuration).

An initial connection must receive a refresh token. On a bound reconnect, an omitted refresh token can retain the existing token only if the returning verified subject matches the stored subject. `refreshGrant` checks the refreshed subject again, retains omitted refresh token/scopes, and computes expiry from the returned lifetime. The caller persists the verified grant through the encrypted connection foundation. Revoked/expired tokens map to `RECONNECT_REQUIRED`; consent and missing permissions have separate actionable errors. External OAuth projects in Testing normally issue seven-day refresh tokens for these scopes. [Token lifecycle](https://developers.google.com/identity/protocols/oauth2).

Disconnect invalidates local credentials and queued operations. Do not blindly revoke a Google grant shared with another connected capability: Google may combine scopes into the same grant. Ads and future YouTube connections must keep capability and destination boundaries.

## Discovery and selection

`GET /v25/customers:listAccessibleCustomers` returns only directly authorized roots, and does not paginate. Each root's metadata is read through `POST /v25/customers/{id}/googleAds:search`. Manager accounts are traversed breadth-first using `customer_client.level <= 1`; nested queries retain the directly authorized root in `login-customer-id`. Results distinguish managers from advertisers and include name, currency, timezone and status. Shared advertisers are displayed once while retaining all authorized root contexts. [Accessible customers](https://developers.google.com/google-ads/api/docs/account-management/listing-accounts), [Hierarchy discovery](https://developers.google.com/google-ads/api/docs/account-management/get-account-hierarchy).

Search uses fixed pages of 10,000 rows. Subsequent requests keep the same query and include the returned `nextPageToken` as `pageToken`; no page size or pagination URL is accepted. Repeated tokens and unbounded traversal are rejected. [Search pagination](https://developers.google.com/google-ads/api/docs/reporting/paging).

The selected advertiser/context pair must belong to server discovery. `verifyAccount` rediscovers that membership, refuses manager destinations, and re-reads the customer through the selected context while retaining all freshly discovered root contexts. Selection persists the fresh name, currency, timezone and status. A newly suspended or otherwise non-enabled account is marked unavailable, deselected and has pending/running local operations cancelled before returning `ACCOUNT_NOT_AVAILABLE`; cached enabled metadata cannot authorize selection. Read-only diagnostics may still inspect its status and campaigns when Google permits, without enabling selection or establishing write readiness. Persist the validated customer ID and manager context; use them for production requests. Direct advertiser access omits `login-customer-id`. A parent manager context is not interchangeable with another context: roles can differ for the same advertiser. [Access model](https://developers.google.com/google-ads/api/docs/oauth/access-model).

Ads has a single API scope for read and write. The user's Ads role, inherited through the selected root, controls permissions independently of the Cloud project's API access level. Metadata/read success establishes read readiness only; write readiness remains `UNKNOWN`. This connection client performs no campaign mutation and does not claim write approval.

## Local Mockoon checks

The fixture is `tests/mockoon/google-ads.json`. Install the repository's `@mockoon/cli` dependency and run:

```sh
npx tsx --test tests/integration/google-ads-provider.test.ts
```

The test starts the actual Mockoon CLI on an available loopback port and shuts it down after the suite. A missing CLI/server fails explicitly. For a temporary CLI install outside the repository, set `MOCKOON_CLI_PATH` to its `bin/run.js`. The fixture can also be inspected/run independently:

```sh
npx mockoon-cli start --data tests/mockoon/google-ads.json --hostname 127.0.0.1 --port 3910
```

Mockoon overrides require **both** server configuration `mockoonEnabled: true` and `mockoonBaseUrl: "http://127.0.0.1:3910"`. Only clean HTTP loopback origins are accepted; paths, credentials, query strings and external hosts are rejected. Never derive these settings from an API body, header or query, and keep the override disabled in live deployment. Google credentials must not be used with fixtures.

Fixture consent redirects with `code=success` while retaining state. Successful exchange returns `google-sub-1`, `mock-access`, and `mock-refresh`. Direct accounts are manager `100`, manager `200` and advertiser `300`; nested manager `101` is under `100`; advertiser `400` is accessible through roots `100` and `200`; advertiser `500` is accessible through `100`. The fixture enforces token form parameters, bearer headers, manager contexts, query type and pagination tokens.

Coverage includes successful/denied exchange, missing scope/subject/expiry/refresh, same-subject refresh preservation, changed-subject rejection, revoked refresh, direct/multiple accounts, paginated nested hierarchy, duplicate advertiser contexts, inaccessible selection, role/project errors, and a paginated read-only campaign report. Provider messages, triggers, bodies and token errors are not copied into application errors; only sanitized structured codes/field paths and request IDs are retained.

## Optional live read evidence

Live credentials and explicit live authorization are not required for Mockoon testing. If absent, report live verification as **skipped: no configured/authorized live pilot**; do not report the fixture's campaigns as real provider evidence.

When a live read pilot is explicitly authorized, use the operator-configured Google OAuth client and a test or approved production project. Authorize the intended user, discover accounts, confirm the reviewed advertiser/root pair, refresh credentials, and run `readCampaigns`. Its query selects campaign ID/name/status, impressions, clicks and cost micros for the last seven days with a limit of ten rows. An empty result is valid and must not be replaced with sample data. Record timestamp, selected account/root, API version and safe request IDs; never record access/refresh tokens, authorization codes or PKCE verifiers. The read client does not create, enable or remove campaigns.

Before implementing a campaign mutation, create a separate `CampaignBudget` in the account currency and reference its resource name. A paused Search campaign needs a bidding strategy and the reviewed EU political advertising declaration in addition to name/channel/status/budget. The existing adapter's inline budget is not a valid Google campaign contract. [Budget fields](https://developers.google.com/google-ads/api/reference/rpc/v25/CampaignBudget), [Campaign creation](https://developers.google.com/google-ads/api/docs/campaigns/create-campaigns), [Required declaration](https://developers.google.com/google-ads/api/docs/api-policy/eu-par).

## Application routes and operator settings

Apply the additive provider-discovery migration and regenerate Prisma. Configure `APP_ORIGIN`, `DATABASE_URL` and the vault keyring as described in [the foundation setup](customer-connection-foundation.md). Run `npm run mock:google` and set `CONNECTION_MODE=mock` with `GOOGLE_ADS_MOCKOON_URL=http://127.0.0.1:3910` for local connections. Mock mode uses synthetic client credentials, ignores live client secrets and stores connections as MOCK. For live mode, set `CONNECTION_MODE=live`, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then register `${APP_ORIGIN}/api/connections/google/callback` in the matching Cloud project. Live mode ignores the mock URL. Existing grants cannot change modes or forward mock credentials to live adapters.

| Route | Method and body | Purpose |
| --- | --- | --- |
| `/api/connections/google/start` | POST `{authorizationId?: string}` | Start new consent or an owned reconnect |
| `/api/connections/google/callback` | GET provider code/state | Verify identity and persist encrypted grant/discovery |
| `/api/connections/google/{id}/refresh` | POST `{}` | Refresh expired offline credentials and rediscover accounts |
| `/api/connections/google/{id}/select` | POST `{destinationId, loginCustomerId}` | Reverify and select an advertiser using a discovered root; null means direct access |
| `/api/connections/google/{id}/check` | POST `{destinationId}` | Read-only selected-context account/report smoke |
| `/api/connections/destinations/{id}` | PATCH `{selected: false}` | Deselect a destination and cancel pending work |
| `/api/connections/{id}` | DELETE | Disconnect local access without revoking independent social grants |

Every mutation requires the session and exact application Origin. Callback state is bound to that session. No endpoint accepts raw tokens, customer identity claims, provider URLs or arbitrary manager context. Access-token expiry with a refresh token is refreshable; invalid_grant/subject mismatch disables access and requires reconnect. One read-only 401 retry may refresh credentials; mutations never use that retry path. An empty campaign report is valid. Write readiness remains UNKNOWN, and live advertising HTTP execution remains disabled until #6/#7 establish its routing and paused validation.

Run `npx tsx --test tests/integration/google-connections.test.ts tests/integration/google-ads-provider.test.ts tests/integration/customer-connections.test.ts` for provider plus database-backed authenticated route tests. These cover concurrent reconnect/disconnect, one-time callbacks, selected manager contexts, tenant isolation, credential expiry/revocation and mode isolation. Live read evidence is unvalidated because Mockoon was requested instead of real pilot credentials.
