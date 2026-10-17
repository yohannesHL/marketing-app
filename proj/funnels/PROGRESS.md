# Funnel implementation progress

Status: #36 merged; #37 ingestion and matching implementation under review. User authorized sequential PR creation and merges for #36–#42.

| Issue | State | Evidence |
| --- | --- | --- |
| #36 | Merged | [PR #43](https://github.com/yohannesHL/marketing-app/pull/43), commit `cfabf9d`; all required CI passed |
| #37 | Implementation review | Owned storage, real receipt routes/SDK, signed provider adapters, matching/recovery worker; 438 security tests passed; live provider proof still pending |
| #38 | Not started | Depends on #36/#37 |
| #39 | Not started | Depends on #36; scheduled after #38 for sequential delivery |
| #40 | Not started | Depends on #38/#39 |
| #41 | Not started | Depends on runtime slices for production behaviour |
| #42 | Not started | Reporting and integrated validation |

## Decisions and evidence, 17 October 2026

- User confirmed native LaunchPad forms/API, Calendly bookings, Shopify purchases and Resend delivery; LaunchPad owns email cadence.
- Isolated worktree based on remote main `802050e`; original dirty checkout preserved.
- Reconciled social/connection dependencies with merged PRs #19–#34. Existing social worker is real but not a generic funnel runner.
- [Contract](../../docs/funnels/contracts.md) records owner/subject/campaign/version/membership/retention/routing defaults and external rollout prerequisites.
- Required runtime is Node 24.16+ in the Node 24 line; the host default Node 26 is not used for project checks.

Live provider setup, approved test resources and pilot outcomes have not been established. They remain explicit release evidence, separate from implementation and fixture validation.

## Issue #37 implementation evidence

- Fresh full migration and legacy upgrade passed; additive constraints preserve advertising/social records. Direct database checks reject cross-owner/environment links and evidence rewrites.
- Real SQLite integration tests cover two concurrent clients, independent enquiries/orders, signed HTTP ingress, forwarded booking correlation, idempotency conflicts, history-only recovery, deletion and late evidence.
- Provider protocol tests cover Calendly reschedules, Shopify lossless IDs, pending versus successful refunds, fixed-endpoint reconciliation, paging and failures.
- Public SDK has no load-time collection; consent gates measurement and native forms can be submitted independently without a visitor token.
- Receipt matching is an independent durable worker. No funnel evaluation or external campaign execution is claimed in this slice.
- Remaining rollout evidence: actual Calendly/Shopify setup, real received/matched provider events and authorized integrated pilots. Matched-history retention must become lifecycle-aware when journeys/jobs are introduced.
