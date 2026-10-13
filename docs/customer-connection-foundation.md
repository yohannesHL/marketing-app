# Customer sessions and secure connection foundation

Issue [#3](https://github.com/yohannesHL/marketing-app/issues/3) adds the shared server foundation for Paid advertising and Social publishing. Each authenticated customer owns their authorizations, destinations and operations. Google/Meta provider login and discovery are implemented in follow-up issues; this foundation does not expose an endpoint that accepts customer-supplied provider tokens.

## Ownership and credential model

- `User` is the customer ownership boundary for this phase. Team workspaces and delegated roles are later work.
- `CustomerSession` stores a hash of an opaque random session token. Cookies are HttpOnly, SameSite=Lax, Path=/ and Secure with a `__Host-` name on HTTPS. Sessions expire after seven days and are invalidated on sign-out or an operator password reset.
- Customers are provisioned by a trusted operator. Local sign-in uses normalized unique login emails, salted scrypt password hashes and a persistent per-email attempt limit of ten attempts per fifteen minutes. Public signup and a customer password-reset UI are not part of this issue.
- `ProviderAuthorization` stores credentials separately from destinations. Ads and social grants have separate capability records, even when they refer to the same provider user. One grant can contain several ad accounts or social destinations.
- `ConnectionDestination` contains only identity/metadata and an explicit selection flag. The browser may select discovered destinations; trusted provider modules register them.
- `ConnectionOperation` is a persistent authorization gate for future workers, rather than a full publishing queue. It records the destination, required permissions and authorization generation. A worker rechecks selection, status, expiry and permissions before obtaining credentials. Operations are claimed once; failed or uncertain external outcomes are not automatically retried here.
- AES-256-GCM encrypts tokens and PKCE verifiers. A random IV is used for each encryption. Authenticated context binds credentials to the customer, authorization and credential field. Swapping ciphertext between customers/fields fails authentication.

## Server configuration

Set these in the deployment secret store, or in `apps/web/.env` for local development. Preserve existing settings. `.env.example` supplies names and nonsecret examples.

| Setting | Requirement |
| --- | --- |
| `APP_ORIGIN` | Exact HTTPS app origin. HTTP is accepted only for loopback development/test hosts. Mutation requests must send this exact Origin. |
| `DATABASE_URL` | SQLite/libSQL database URL. Use an absolute file URL for operator scripts and tests to avoid ambiguity. The development fallback is `file:./prisma/dev.db` from the web workspace. |
| `CONNECTION_TOKEN_KEYS` | JSON object mapping key IDs to canonical base64 encodings of 32 random bytes. Server secret; never use `NEXT_PUBLIC_`. |
| `CONNECTION_ACTIVE_KEY_ID` | Existing key ID used for all new encryption. |
| `ADS_MODE` | Set `mock` for the demo/tests. Live HTTP advertising remains gated until provider integration validation. |
| `INTERNAL_BASE_URL` | Optional trusted internal origin for mock platform requests. It must point to this app; session cookies are forwarded for ownership checks. |

Generate a key with Node's cryptographic random-byte generator or your secret manager. The following prints a new key; store its output securely rather than committing it:

```sh
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))'
```

Install it in a keyring shaped like `{"v1":"the generated base64 value"}` and set the active key ID to `v1`. Empty, malformed or missing keys fail closed. This implemented keyring supersedes the earlier proposed `ADS_TOKEN_ENCRYPTION_KEY` setting in planning documents.

## Database migration and legacy credentials

Stop app/worker traffic and take an access-controlled backup before migrating an existing database. Keep the configured encryption keys available throughout migration and later restore operations.

1. Generate the Prisma client with `npm exec --workspace @launchpad/web -- prisma generate`.
2. For a fresh local SQLite database, first create its parent directory and an empty database file at `DATABASE_URL` (Prisma 7 may otherwise report a schema-engine error), then run `npm exec --workspace @launchpad/web -- prisma migrate deploy` to apply the checked-in migration history. For an existing database with matching migration history, the same command applies the additive `20261013000000_customer_connections` migration. It adds session/connection tables and nullable login/owner columns while preserving existing users, accounts and campaigns.
3. Run `npm --workspace @launchpad/web run security:migrate-legacy` with the database and keyring configured.
4. Confirm the command succeeds before allowing traffic. Rerunning it is safe. It encrypts legacy token columns in a transaction and creates disabled, unselected `RECONNECT_REQUIRED` records for owned legacy accounts. It does not invent provider identities or permissions. Unowned legacy accounts remain encrypted historical records, with no customer access assigned.
5. Reconnect legacy accounts through the relevant provider integration when available. Existing campaign/account IDs are preserved. The runtime account repository never reads legacy token columns.

For an existing database, inspect its table and migration state before deployment. If it predates the checked-in history, establish a reviewed baseline and apply only missing migrations; do not replay historical create-table migrations or reset the database. Security tests independently construct the legacy schema fixture and apply the additive migration. No existing developer database is migrated by the test suite.

Legacy encryption enables SQLite secure deletion and rebuilds the database with VACUUM to remove old credential bytes from local database pages. Previously taken backups, journals or replicas must follow the deployment's retention/encryption policy; rewriting current records does not rewrite past backups. Large migrations should run during maintenance; errors are sanitized and should be diagnosed without printing credential rows.

## Provisioning and resetting customer access

Run `npm --workspace @launchpad/web run security:customer` with a JSON object supplied through standard input from a secure credential source:

```json
{
  "email": "customer@example.com",
  "name": "Customer name",
  "password": "a unique password of at least 15 characters"
}
```

Passwords may contain up to 256 characters. Supply optional `userId` only after verifying the identity of an existing customer: this updates that customer and invalidates their existing sessions and pending OAuth attempts. Without `userId`, provisioning creates a new customer. Duplicate login emails are rejected. The command outputs only the customer ID and never echoes the input. It has no public HTTP counterpart.

## Public API

All responses use `Cache-Control: no-store`. Connection responses are explicit metadata projections; encrypted blobs, access tokens, refresh tokens, session hashes and PKCE verifiers are excluded.

| Request | Behavior |
| --- | --- |
| `POST /api/auth/login` | JSON email/password, exact Origin; returns customer metadata and sets a session cookie. |
| `GET /api/auth/session` | Returns the signed-in customer ID. |
| `DELETE /api/auth/session` | Requires exact Origin; invalidates the session and clears the cookie. |
| `GET /api/connections` | Lists only this customer's authorization metadata and destinations. |
| `GET /api/connections/:id` | Returns this customer's connection or 404. |
| `DELETE /api/connections/:id` | Requires exact Origin; locally disconnects this customer's grant and returns metadata. |
| `PATCH /api/connections/destinations/:id` | JSON containing only `selected: boolean`; requires exact Origin and ownership. |

These are API foundations. A customer-facing sign-in page and connection settings UI are follow-up work. For manual API testing, retain the cookie returned by login and send the configured Origin on every mutation. Neither a body `userId` nor a URL customer ID establishes identity.

## Provider module contract

Trusted server modules call `beginOAuth` with their configured provider, capability, exact callback URI, scopes and explicit PKCE policy. State lasts ten minutes, is stored hashed, and is bound to the initiating user/session/provider/capability/callback.

Provider callbacks call `claimOAuthExchange` before contacting the provider. It atomically reserves the attempt and returns the PKCE exchange context plus a private `exchangeClaimToken`; only its hash is stored. Duplicate callbacks cannot exchange the code again or cancel the winning callback. Pass that token as the final argument to `completeAuthorization`, or to `ProviderConnectionState.cancelOAuth` when the exchange fails. Final consumption and grant persistence occur in one transaction. Disconnect and session expiry still invalidate claimed attempts. Existing trusted foundation callers may complete unclaimed attempts without a token, but cannot complete or cancel a claimed attempt. Never serialize the verifier or claim token to a browser or accept provider tokens, scopes, callback URLs or claim tokens from a browser body.

Provider discovery registers destinations. Marketing actions must go through `queueOperation` and `runOperation`; the callback receives decrypted credentials only after access has been rechecked. Ad services create a separate adapter per selected account, avoiding shared mutable account credentials. Required provider scopes are chosen by trusted operation code, not the client.

`renewAuthorization` supports server-side refresh exchange even when an access token has expired. Credential updates use a version check, so a late refresh cannot undo disconnect or overwrite newer credentials. Providers without refresh support must reconnect. Provider exceptions are sanitized before returning from this boundary.

## Disconnect revocation and retention

Local disconnect deletes usable access/refresh ciphertext, deselects destinations, advances the authorization generation and cancels pending/running local operation records. Metadata and fixed audit events remain for reconnect and operational history. A reconnect updates the existing verified grant and preserves destination IDs; it cancels work from older generations.

Local disconnect of Ads does not disconnect Social. A verified provider revocation callback can call `markProviderRevoked` with the provider's verified grant identifier; this disables all capability records sharing that external grant. Provider modules must explain the broader effect before requesting remote revocation.

Already submitted network requests cannot be unsent by local disconnect. Full scheduling adapters must additionally cancel any provider-side scheduled publications. This foundation does not claim to cancel remote schedules or delete already published posts.

Run `npm --workspace @launchpad/web run security:prune` periodically to delete expired sessions/OAuth verifiers and elapsed login-attempt buckets. A complete customer-data deletion workflow is separate from retaining disconnected connection metadata and must match the published policy.

## Key rotation

1. Add a new random key while retaining old keys; update the active ID.
2. During maintenance, run `npm --workspace @launchpad/web run security:rotate-keys`. It transactionally reencrypts current grant credentials, unexpired/stored PKCE verifiers and migrated legacy token columns; credential versions advance so stale refreshes are rejected.
3. Verify provider connections and database restore procedures before retiring an old key. Preserve old keys for retained backups that still require them.

Losing required keys prevents decryption; reconnecting may restore provider access, but does not recover historical encrypted data. Keep key material in the agreed secret store.

## Verification

- `npm run test:security` exercises the public session/connection service and HTTP interfaces against a temporary real SQLite database, including legacy migration and key rotation.
- `npm run test:e2e -- tests/e2e/customer-security.spec.ts tests/e2e/ads-proxy.spec.ts --project=chromium` builds and starts an isolated app with generated test keys and fixture customers; it never reuses the developer database.
- TypeScript validation and Prisma schema validation cover the web workspace.
- Recon LSP is used for semantic navigation of the changed authentication/connection paths.

No provider network request is part of issue #3, so Mockoon is not required here. Provider token exchange/discovery tests in the subsequent integration issues can use Mockoon at that external boundary. Actual Google/Meta connections remain gated on those integrations and platform approvals.

## Runtime baseline

The foundation uses Next.js 15.5.27 with its matching ESLint configuration. Next 14 is outside the supported security line; the upgrade includes asynchronous dynamic-route parameters and is verified with the application build and browser tests. See [Next.js security release](https://nextjs.org/blog/august-2026-security-release) and [Next 15 upgrade guide](https://nextjs.org/docs/app/guides/upgrading/version-15). The application retains the libSQL Prisma mapping. Persistent local files use explicitly owned built-in SQLite connections on Node 24.16.0 or a later Node 24 release to release failed and finished transactions; remote and in-memory clients retain libSQL handling. See [storage operations](social-delivery.md). The unused native `sqlite3` package has been removed.
