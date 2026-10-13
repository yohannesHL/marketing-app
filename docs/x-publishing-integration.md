# X publishing and API cost controls

## Owner setup and customer consent

Create the business-owned X developer project/app, enable a confidential Web OAuth 2 client, and register the exact deployed `APP_ORIGIN` plus `/api/connections/x/callback`. Request `tweet.read users.read tweet.write media.write offline.access`. The app uses session-bound private state and PKCE S256; it verifies the stable user ID through `GET /2/users/me`, rather than treating a username or email as identity. App-only credentials cannot authorize customer publishing. X documents a two-hour default access token; this implementation stores the actual response expiry and replacement refresh token. [OAuth Web configuration and scopes](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code).

Customer publishing and paid advertising permissions remain separate. Explain the actual scheduled actions, obtain approval of the saved content/revision and exact destination, and honor cancellation and opt-out. Do not use this integration to duplicate posts across accounts or automate spam. OAuth consent alone is not posting consent. [Automation requirements](https://help.x.com/en/rules-and-policies/x-automation).

No real X app-owner configuration, credit funding, approved customer pilot, live post or external cleanup has been completed here. Keep the [social readiness tracker](social-publishing-readiness.md) open until that evidence exists.

## Costs and stop controls

X API use can incur charges for identity reads, media operations, posting and outcome checks. The current pricing page lists standard post creation at $0.015, URL-post creation at $0.200 and user reads at $0.010; rates can change. Verify the app's actual console rates, media-operation prices and credit funding before the pilot. The special app-owner read pricing cannot be assumed for third-party customers. [Current credit-based pricing](https://docs.x.com/x-api/getting-started/pricing).

The Connections UI requires a blank-default maximum in US dollars before connect/reconnect, refresh or identity-check actions. Each action consumes the explicit approval and clears the field. Renewing expired credentials may require another identity read. Selecting the already verified cached identity makes no new provider request and requires no new allocation; selection still does not authorize publishing.

The composer calls the owned local estimate endpoint with only destination, current text, format and inspected attachment IDs. It validates weighted text and derives an allocation from configured conservative rates, without contacting X or reserving spending. The display distinguishes the initial allocation from a possible renewal-inclusive allocation. A URL changes the configured creation rate. It never invents the actual bill or provider credit balance. Debouncing and stale-response guards keep old text estimates from replacing the current draft's estimate. Mockoon rates are explicitly synthetic.

The customer chooses a separate publishing cost ceiling and explicit Yes/No AI and partnership disclosures. Limits accept up to six decimal places and convert exactly to integer USD micros on the server contract. Saving a draft does not spend or publish. The immutable delivery allowance, customer/day limits and operation ceilings independently constrain every billable request, including read checks and renewal verification. Allocations are conservative application reservations, not proof of exact provider billing or available credits. Insufficient credits, missing approval or exceeded allowances block the affected workflow; they do not grant another unapproved retry.

## Server configuration

| Setting | Purpose |
| --- | --- |
| `APP_ORIGIN`, `CONNECTION_MODE=live` | Exact deployed customer origin and real provider endpoints, without local fallback |
| `X_CLIENT_ID`, `X_CLIENT_SECRET` | Confidential business-owned client, held only in the server secret store |
| `X_API_PRICES` | Operator-confirmed conservative integer USD-micro rates for every implemented operation |
| `X_API_OWNER_BUDGETS` | Explicit owner/mode daily and delivery limits and operation ceilings |
| `SOCIAL_MEDIA_DIRECTORY`, `SOCIAL_MEDIA_PUBLIC_ORIGIN`, `SOCIAL_MEDIA_SIGNING_KEY` | Retained inspected media and privately signed worker delivery |
| `SOCIAL_PUBLISHING_ENABLED`, `SOCIAL_APPROVED_PROVIDERS` | Separate write switch and explicit supported destination allowlist |

`X_API_PRICES` requires `USER_READ`, `POST_READ`, `POST_CREATE`, `POST_CREATE_URL`, `POST_DELETE`, `MEDIA_UPLOAD`, `MEDIA_INIT`, `MEDIA_APPEND`, `MEDIA_FINALIZE` and `MEDIA_STATUS`. Do not guess media prices or silently use zero for an unknown rate. Each budget entry identifies `ownerId`, `mode`, `dailyLimitMicros`, `deliveryLimitMicros` and `operationCeilings`. The server catalog exposes only the configured identity-read allocation for the signed-in owner; it exposes no tokens or provider credit balance.

Keep `SOCIAL_PUBLISHING_ENABLED=false` and `SOCIAL_APPROVED_PROVIDERS=[]` during connection-only review. After an explicitly approved pilot and satisfied external gates, the supported destination entry is `X:X_PROFILE`. Set the X Developer Console spending cap as well as application limits. To stop new submissions, first stop affected worker processes, disable writes/remove X from the allowlist, and redeploy or restart the web app and workers with that configuration. Changing environment or secret-store values alone does not update a running worker. Preserve in-flight receipts; shutdown cannot undo an already accepted provider request. [Shared worker operations, migrations, backup and key rotation](social-delivery.md).

## Delivery, media and recovery

The initial path supports standard text, up to four inspected images or one inspected video. The official weighted validator enforces the standard 280-character limit, including emoji/Unicode weighting and shortened URLs. The server probes real bytes and checks the implementation's format/size limits. The shared media store defaults to 64 MiB per upload; the configured application storage ceiling remains stricter than X's documented standard video ceiling. The SDK uses the standard 20-minute video limit and does not enable extended Premium uploads. It uses the documented default post-video limits (20 minutes and 8 GB), with the application currently imposing a tighter 64 MiB upload cap. It does not query extended-video entitlements; final provider acceptance is still required. Current v2 media endpoints handle simple image upload and resumable video initialize/append/finalize/status. Processing readiness and media expiry are checked before one final post-creation boundary; upload acceptance alone is not publication. [Weighted text rules](https://docs.x.com/fundamentals/counting-characters), [media limits and endpoints](https://docs.x.com/x-api/media/introduction), [post creation and disclosures](https://docs.x.com/x-api/posts/create-post).

The application schedules due work locally; no native X scheduling feature is claimed. A durable lease and per-request owner/mode/authorization-generation/revision checks fence provider calls. Media progress and accepted receipts remain encrypted. Lost creation responses remain uncertain and cannot be retried blindly; the adapter checks a known provider receipt when available and does not create another post because an outcome read failed. Unknown creation without a receipt remains unknown. Rotating refresh is serialized across browser and worker, requires prefunded identity verification and saves only verified same-subject credentials. An ambiguous exchange requires reconnection rather than reusing an old rotating token.

Known-post cleanup is limited to the owned receipt and authorization and requires its own API allowance and confirmation. Local cancellation, disconnection or deletion of application records is not proof that a post was removed from X. Preserve the database, decryption keys, budget ledger and progress during recovery. An approved live pilot must record its actual post receipt, verified outcome and external cleanup.

## Fixture evidence and remaining gates

Use `CONNECTION_MODE=mock` with explicit loopback `X_MOCKOON_URL` for HTTP contracts. Synthetic identities, rates, credits/errors and media receipts do not establish app approval or a paid provider account. The browser journey connects/selects the actual fixture, proves explicit connection limits and cached selection behavior, requests real local quotes for weighted Unicode and URL text, checks stale-response isolation, and saves the actual reviewed draft with writes disabled. It captures mobile/desktop screenshots and enqueues no publication. Test source alone is not a passing result; record the actual Chromium/Firefox/WebKit checks with the exact release commit.

Before live rollout, record owner console/client/scopes, current verified prices and media ceilings, credits and console/application stop limits, verified customer identity, review recording, saved revision and schedule, actual provider final result, billed usage evidence where available, and cleanup. No automation should activate that pilot or declare public production readiness from Mockoon evidence. Primary contracts rechecked on 13 October 2026.
