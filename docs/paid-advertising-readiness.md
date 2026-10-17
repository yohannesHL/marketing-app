# Paid advertising release readiness

This is the integration handoff for [#8](https://github.com/yohannesHL/marketing-app/issues/8). The implemented release securely connects and reads selected Google/Meta advertising accounts. Fixture validation is complete; public onboarding and actual account pilots remain gated by owner/provider prerequisites. Campaign and asset writes remain disabled. Connecting, selecting, checking or reconnecting an account never starts advertising spend.

## Delivered engineering work

| Work | Evidence |
| --- | --- |
| Owner setup and secure customer foundation | [Setup guide](customer-ad-account-setup.md), merged [PR #19](https://github.com/yohannesHL/marketing-app/pull/19) |
| Google OAuth, offline renewal, advertiser/manager discovery and verified reads | [Google guide](google-ads-connection.md), [PR #20](https://github.com/yohannesHL/marketing-app/pull/20) |
| Meta Business Login, account roles/expiry, signed removal and data deletion | [Meta guide](meta-ads-connection.md), [PR #21](https://github.com/yohannesHL/marketing-app/pull/21) |
| Customer sign-in/settings, explicit selection, separate Ads/Publishing grants, independent account routing | [Settings guide](customer-connection-settings.md), [PR #22](https://github.com/yohannesHL/marketing-app/pull/22) |
| Repeatable CI, restored wizard validation and opt-in read-only pilot/rollback | [Controlled rollout](paid-ads-rollout.md), [PR #23](https://github.com/yohannesHL/marketing-app/pull/23) |

The connection batch and handoff were merged in PRs #19–#24. The [17 October completion audit](implementation-completion-audit.md) separates completed engineering from optional live rollout. Code delivery does not establish platform approval or publication readiness.

## Verified fixture evidence

- 88 backend tests pass across authentication, OAuth claims/refresh, provider discovery, role/status loss, concurrent account contexts, customer/capability/mode isolation, deletion timing and read-only pilot security. Provider calls use real local Mockoon HTTP servers and disposable SQLite databases.
- All 27 active app cases pass across Chromium, Firefox and WebKit: home, campaign wizard, customer isolation, explicit demo proxy and customer connections. Skipped Storybook/placeholder specifications are excluded.
- A read-only pilot command against the actual temporary app successfully checks two explicitly selected Google/Meta fixture destinations and returns `mode: mock`, `writesEnabled: false`. It performs no create, activation or cleanup request.
- Fresh Prisma CLI migration deploy applies all six migrations to an empty temporary database. Production build and strict TypeScript checks pass.
- [Connection screenshots](evidence/customer-connections/README.md) and [QA screenshots/JUnit/mock pilot summary](evidence/paid-ads-qa/README.md) contain synthetic fixture data. Live provider evidence is absent.

The server derives ownership from the customer session, validates every supplied selected destination before any provider call and rechecks identity, scopes, mode, selected access path and credential version before saving successful results. Final validation and history insertion share a transaction, preventing a late read from restoring data erased by a deletion callback. Provider invocations record authorization/destination/mode provenance so removal/deletion can preserve unrelated records.

## Operator handoff and public-release gates

| Required item | Current status | Owner/action |
| --- | --- | --- |
| Staging/production HTTPS origins, reviewed privacy/terms/deletion policies and support details | Not supplied | Yohannes supplies and registers exact values |
| Google Cloud API project access, Web OAuth client, registered callback and required verification/quota status | Not supplied | Yohannes follows the Google setup guide; engineering verifies configuration |
| Meta business/app/configuration, reviewed permissions, callback/lifecycle URLs and external-customer access | Not supplied | Yohannes completes Meta setup/review; engineering verifies signed callback compatibility |
| Production database/keyring/credential secret-store handoff, backup/restore and legacy provenance cleanup | Not validated in a deployment | Operator installs references and rehearses maintenance while access is disabled |
| Dedicated Google/Meta pilot customer destinations and permissions | Not supplied | Owner provides approved accounts and Google access paths/Meta tasks |
| Actual consent/discovery/read/reconnect/disconnect evidence for each provider | Not performed | Explicitly authorized operator pilot after configuration; record each provider separately |
| Passing GitHub CI for the connection release and reviewed merge batch | Complete; PRs #19–#24 merged | Merged connection handoff `597ef390db07542fb34dd98815c58530f61c9c08` |
| Live campaign/asset write enablement and paused probe/cleanup/idempotency validation | Unavailable and unperformed | Separate supported implementation and validation; no write flag enables it here |

The user chose Mockoon validation instead of providing live staging credentials. That permits deterministic engineering checks and leaves the live/platform items visibly open. Per the owner’s 17 October instruction, these external tasks do not block engineering issue closure. They remain prerequisites for a future live rollout; mock receipts are never real account evidence.

## Deployment and stopping access

Start with `CONNECTION_MODE=disabled` and `ADS_MODE=disabled`. Apply the approved additive migrations and install the matching vault keys, customer login configuration and provider secrets. Enable `CONNECTION_MODE=live` only for an approved connection-only pilot. Advertiser billing remains with the customer's provider account; this release does not rebill spend. Review any provider API/quota costs and app hosting separately.

For a fixture environment, use `CONNECTION_MODE=mock` plus loopback Google/Meta Mockoon URLs. `ADS_MODE=mock` enables the clearly labeled legacy advertising demo only outside live connection mode. Demo TikTok support is not a real customer integration. Missing credentials, provider outages or unsupported platforms never become simulated live success.

To stop live access, disable both modes and restart every app instance, then stop any workers. Retain Meta signing configuration and deletion receipt routes so provider lifecycle requests remain processable. Use confirmed per-grant disconnect for an affected customer; in-flight provider requests cannot be unsent. Follow the [rollback and incident guide](paid-ads-rollout.md) rather than restoring revoked credentials or dropping security tables.

Social publishing is a separate delivery tracked by #9–#18: YouTube Shorts, Facebook Pages, Instagram, TikTok, LinkedIn and X. Its grants, destinations and reviewed post/scheduling workflow must remain separate from paid campaign goals, budgets and launches.
