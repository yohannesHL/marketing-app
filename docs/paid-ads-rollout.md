# Paid advertising: connection checks and controlled rollout

Issue [#7](https://github.com/yohannesHL/marketing-app/issues/7) delivers repeatable fixture evidence and an opt-in read check. The user chose Mockoon validation on 13 October 2026. **This delivery establishes connection-only readiness. Actual Google/Meta pilot reads, platform approvals, live campaign/asset writes, activation and spending remain unvalidated. Live writes stay disabled.** Connecting an account or checking readiness never creates a campaign.

Read access does not establish advertising write permission, spending authorization, audience/creative eligibility or campaign delivery. The wizard's mock launch and retry evidence covers the simulated workflow only. It does not validate live write idempotency or recovery from an unknown provider outcome. Ads permissions also do not authorize Social publishing.

## Repeatable fixture checks

[Customer connections CI](../.github/workflows/customer-connections.yml) uses Node 24, the committed dependency lock, generated Prisma, a fresh database migration, and `npm run test:security`. It installs Playwright browser/system dependencies and runs all active app journeys across Chromium, Firefox and WebKit:

- Home entry and the campaign wizard's guidance, validation, upload, service-error and mock launch/retry flows.
- Customer session and execution-log isolation.
- Google/Meta consent, account discovery, explicit manager context/account selection, read readiness, reconnect, disconnect and visible errors.
- The mock advertising proxy and persisted execution results.

The isolated app creates disposable customer/database/key fixtures and starts local Mockoon HTTP providers. It never reuses a developer database or needs production secrets. Skipped Storybook foundation and obsolete placeholder ATDD specs require a separate runner and are excluded; skipped scenarios are not passing customer-flow evidence. Browser reports/traces and security output are retained for 14 days with the commit SHA in the artifact name. Artifacts contain synthetic fixture data only. Do not upload live session traces, cookies, environment files or customer/provider payloads into these artifacts.

For a local equivalent after `npm ci`:

```sh
npm exec --workspace @launchpad/web -- prisma generate
npm run test:security
npm exec -- playwright install chromium firefox webkit
BASE_URL=http://127.0.0.1:3145 npm run test:e2e -- tests/e2e/home.spec.ts tests/e2e/customer-security.spec.ts tests/e2e/customer-connections.spec.ts tests/e2e/ads-proxy.spec.ts tests/e2e/campaign-wizard.spec.ts
```

The app bootstrap builds the web workspace. CI additionally checks TypeScript. The configured browser selection contains 27 cases in five files; attach the actual green CI run and its exact commit before release sign-off. Local validation on 13 October 2026 passed all 27 selected cases across the three browsers and all 88 backend tests. The read-only pilot CLI also passed against the temporary application and both actual local Mockoon providers. Sanitized evidence is in [paid advertising QA](evidence/paid-ads-qa/README.md). Configuration or test discovery alone is not successful execution. GitHub Actions and browser-install configuration follows the current [checkout](https://github.com/actions/checkout), [setup-node](https://github.com/actions/setup-node), [artifact](https://github.com/actions/upload-artifact) and [Playwright CI](https://playwright.dev/docs/ci-intro) documentation; action revisions are pinned in the workflow.

## Deployment modes and secrets

Use separate databases and origins for fixtures and a real-account pilot. Do not relabel a MOCK connection as LIVE or copy fixture credentials to a real provider. Existing same-subject connections cannot switch modes. A production-like pilot must start with a clean, explicitly configured live environment and real provider consent.

| Setting | Fixture environment | Connection-only live pilot |
| --- | --- | --- |
| `APP_ORIGIN` | Exact loopback origin such as `http://127.0.0.1:3145` | Exact registered HTTPS origin; no path/query/fragment |
| `DATABASE_URL` | Disposable SQLite database | Approved database; absolute URL for operator commands |
| `CONNECTION_TOKEN_KEYS`, `CONNECTION_ACTIVE_KEY_ID` | Fresh synthetic keyring in the test bootstrap | Secret-store keyring containing canonical base64 32-byte keys and its active ID |
| `CONNECTION_MODE` | `mock` | `live` only after owner configuration and pilot authorization |
| `ADS_MODE` | `mock` | `disabled`; live campaign and asset routes remain unavailable |
| `GOOGLE_ADS_MOCKOON_URL` | Local Google fixture, normally port 3910 | Omit; live ignores fixture URLs |
| `META_ADS_MOCKOON_URL` | Local Meta fixture, normally port 3911 | Omit; live ignores fixture URLs |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Synthetic server configuration | Approved server-only Web OAuth client from the intended Cloud project |
| `META_APP_ID`, `META_APP_SECRET`, `META_LOGIN_CONFIG_ID` | Synthetic server configuration | Approved server-only Meta app and Ads USER-token Business Login configuration |
| `META_GRAPH_VERSION`, `META_MARKETING_VERSION` | Tested default `v26.0` | Tested supported version, currently `v26.0`; recheck provider support before rollout |

The Google client currently uses REST `v25`; API access belongs to the OAuth client's Cloud project. Follow the exact approvals/settings and current policy sources in [Google setup](google-ads-connection.md), [Meta setup](meta-ads-connection.md), [customer security](customer-connection-foundation.md) and the [owner setup guide](customer-ad-account-setup.md). There is no new campaign-write enablement flag in this delivery. Setting `ADS_MODE=live` does not authorize or enable live writes. Provider secrets and vault keys must never use `NEXT_PUBLIC_`, source control, browser storage or issue/PR comments.

Register exact callback URIs `${APP_ORIGIN}/api/connections/google/callback` and `${APP_ORIGIN}/api/connections/meta/callback`. Meta also requires the signed deauthorization/data-deletion callback URLs and the public deletion-status route documented in its guide. Preserve lifecycle callback access and signing secrets during an incident, even while customer provider operations are disabled.

## Opt-in read-only pilot

The operator first records the approved customer, dedicated Google/Meta account, Google manager access path if applicable, environment and checking window. Each destination must already have completed real consent and explicit account/context selection. Obtain the **application destination ID** from that customer's authenticated `GET /api/connections`, and compare the account shown in the UI with the approved account. Provider account IDs or an arbitrary customer's destination are not a pilot allowlist.

The pilot script accepts credentials through secure standard input as JSON `{"email":"…","password":"…"}` or through `ADS_PILOT_EMAIL` and `ADS_PILOT_PASSWORD` injected by the approved secret manager's command runner. These are customer sign-in credentials; the script does not accept provider access/refresh tokens. Use one credential source. Do not put passwords in arguments, shell history or files committed to this repository. The script deliberately does not load an environment file; its environment must be supplied by the operator/secret-store runner.

Set `APP_ORIGIN` and `ADS_PILOT_ALLOWLIST` explicitly. The allowlist is a JSON array of dedicated application destination IDs. `--run-read-only` is required every time, and each requested ID must appear in that allowlist. At most 25 unique destinations can be requested. Run through the credential-injecting command runner, or pipe secure JSON into standard input:

```sh
APP_ORIGIN=https://approved-pilot.example ADS_PILOT_ALLOWLIST='["dedicated-google-destination","dedicated-meta-destination"]' npm exec -- tsx apps/web/scripts/ads-pilot-read.ts --run-read-only --destination dedicated-google-destination --destination dedicated-meta-destination
```

Replace the example origin/IDs with approved values; they are not supplied accounts. The live default requires HTTPS and a response explicitly marked `mode: live` and `writesEnabled: false`. For fixture validation only, add `--mock`; HTTP then permits only `localhost`, `127.0.0.1` or `[::1]`, and the response must say `mode: mock`. URL credentials, paths, fragments and query parameters are rejected. HTTPS certificate verification remains enabled. Never run the pilot in CI or automatically against production/customer accounts.

The script logs in once, keeps the temporary session cookie only in process memory, then sends one `POST /api/ads/readiness` containing only the selected `destinationIds`. It rejects redirects, applies a 15-second timeout per application request, and makes no automatic retries. The server may safely refresh Google authorization and retry a read under its documented provider contract; no campaign mutation is part of either path. Do not treat a client timeout as proof the server stopped: it may finish its outstanding read and metadata updates. The temporary customer session follows the normal expiry policy; no cookie is written to disk.

Output is a fixed JSON projection: mode, disabled-write flag, aggregate success/partial status and each requested destination's provider/read status. Account names, provider account IDs, campaigns, customer identity, tokens and provider error text are omitted. Configuration/login/network/malformed-response failures produce one fixed error message; partial/failed read outcomes return exit code 1 and a safe per-destination summary. Exit code 0 proves only that this specific read check succeeded. Investigate a failed destination in the authenticated Connections UI, repair authorization/selection, then explicitly decide whether to run a fresh check. No create/activate/cleanup calls are made.

For pilot evidence, retain the exact release commit, date/environment, approved destination allowlist, output/exit status and reviewer confirmation of the customer/account/context mapping in access-controlled records. Record Google and Meta live reads separately. A mock-mode summary never satisfies either live pilot criterion.

## Maintenance, migrations and keys

1. Stop customer/provider traffic and all workers before schema or credential maintenance. Take a consistent, access-controlled database backup with its migration state; include the required SQLite journal/WAL state using the deployment's supported backup procedure. Retain the vault keys needed to restore it. Test restoration in an isolated environment with provider access disabled.
2. Inspect the deployed migration history with `npm exec --workspace @launchpad/web -- prisma migrate status`. An old untracked schema needs a reviewed baseline; never reset it or replay historical create-table migrations blindly. Generate Prisma and apply the checked-in additive migrations using `npm exec --workspace @launchpad/web -- prisma migrate deploy`. For a fresh file database, create its parent directory and empty file first; Prisma 7 otherwise can report a generic schema-engine error. CI tests the complete migration history separately from legacy-fixture upgrades.
3. Before restoring traffic on a legacy installation, run `npm --workspace @launchpad/web run security:migrate-legacy` with the correct database/keyring. Owned imported grants remain unselected and require real reconnect. Unknown identities/permissions must not be invented. Confirm plaintext credential columns and current database pages have been remediated according to the foundation guide; historical backups/replicas have their own retention obligations.
4. For key rotation, install the new key alongside required old keys, update `CONNECTION_ACTIVE_KEY_ID`, then run `npm --workspace @launchpad/web run security:rotate-keys` during maintenance. Validate reads and an isolated restore before retiring any old key. Preserve keys needed by retained backups. Missing keys are not repaired by a schema rollback.
5. Provision/reset customer access through `security:customer` with secure stdin, and run `security:prune` under the operator's retention schedule. Password reset invalidates existing sessions and pending consent; reconnect through the appropriate provider when required.

Commands target the operator-supplied `DATABASE_URL`, not a developer database. Sanitize operational reports; never print credential rows to diagnose migration/rotation failures.

## Disable, recover and roll back

- To stop customer live reads/connect/reconnect, set `CONNECTION_MODE=disabled` and `ADS_MODE=disabled`, then restart **every** app instance. Stop any workers as well. Existing browser state cannot enable a disabled provider runtime. Preserve Meta callback signing configuration/public receipt routes so verified lifecycle requests can still be processed.
- After restart, verify the sign-in page responds, unauthenticated customer APIs return 401, and an authenticated selected-account check fails with provider-disabled status. Confirm campaign/asset mutation requests remain unavailable. Do not use a create call as a health probe against an enabled provider.
- For a specific compromised/revoked account, use the owning customer's confirmed disconnect. It erases usable credentials, clears selection and cancels pending/running local work. Requests already sent to a provider cannot be unsent. Global environment disable does not claim to cancel every database operation or a remote schedule; stop workers and use the supported per-grant disconnect procedure for affected records.
- For expired/revoked permission, reconnect the same verified provider identity in the same mode, choose an explicit account and Google access path, and rerun a permitted read check. Meta USER-token expiry requires renewed consent; do not fabricate a refresh token. Role/account status loss requires the account owner to restore access before selection.
- On outage/rate limiting, leave writes disabled, inspect sanitized provider status in the UI, and choose a later read check deliberately. Do not loop the pilot or blindly retry an uncertain write. If a future write probe times out, reconcile the provider object before any repeat submission.
- Roll back to a known compatible application artifact while retaining additive schema and required keys. If database restoration is necessary, keep traffic blocked, review data loss/newer lifecycle requests, restore the consistent backup **and matching keyring**, and reconcile disconnect/revocation/deletion decisions before enabling reads. Do not drop new tables or reactivate revoked grants to make an older binary start.

## Meta provenance and deletion

New provider execution evidence must link `authorizationId`, `destinationId` and `connectionMode`; subject/mode lifecycle processing depends on that verified provenance. Meta signed removal invalidates relevant Ads and Social grants; local Ads disconnect is capability-specific. Deletion removes identified provider data and returns a truthful opaque receipt while retaining independent providers/grants.

Before public/live rollout, audit historical Meta-derived invocation/aggregate payloads, imports and backups without verified app-user provenance. The lifecycle store cannot infer an owner from an unlinked legacy row. Remediate those records under the published privacy/retention policy, verify mixed-provider data remains isolated, and review retained event/fence/receipt digests. Do not claim the fixture deletion tests prove historical production data has been erased.

## Outstanding release gates

The following are **unperformed/blocking**, not completed pilot criteria:

- Approved Google Cloud API/OAuth access, Meta app review/business verification/access tier, correct domains/redirects/privacy/deletion configuration and owner secret handoff for the actual customer rollout.
- Separately authorized, recorded live Google and Meta consent/discovery/read checks on dedicated accounts, with verified Google manager context and real Meta account roles.
- Public review of customer isolation, full green CI evidence for the release commit, restoration/key rotation, disable controls, lifecycle callback compatibility and historical Meta provenance cleanup.
- A separately reviewed and explicitly enabled write-probe implementation with persisted external IDs, submission deduplication and reconciliation of uncertain outcomes. No write-probe enablement is implemented here, and the generic live create/asset routes remain disabled.

Before any future paused probe, obtain explicit authorization for the account, exact resources, checking window and cleanup. Confirm provider-specific budget/resource semantics, permission/current role, objective/category/media constraints and zero activation. Validate the minimal supported request first. Create at most the approved PAUSED object, persist its external ID durably, read it back to confirm account/status, test repeat-submission/timeout reconciliation without duplicate creation, then delete only those saved resources and confirm cleanup. Record any budget/resource dependency and residual object if cleanup fails; leave activation and further writes disabled. This checklist has **not** been executed, and mock wizard retries are not evidence that it works live.
