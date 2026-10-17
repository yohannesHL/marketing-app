# Funnel implementation progress

Status: #36 and #37 implementation merged; #38 rules and journey history under review. User authorized sequential PR creation and merges for #36–#42.

| Issue | State | Evidence |
| --- | --- | --- |
| #36 | Merged | [PR #43](https://github.com/yohannesHL/marketing-app/pull/43), commit `cfabf9d`; all required CI passed |
| #37 | Implementation merged; live evidence pending | [PR #44](https://github.com/yohannesHL/marketing-app/pull/44), commit `c9b1649`; all required CI passed; actual provider/pilot evidence remains open |
| #38 | Implementation review | Immutable custom definitions, durable evaluator receipts, property rules, history, internal outbox, templates and no-send simulator; 480 security tests passed before final focused regression additions |
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

## Issue #38 implementation evidence

- Custom declarative definitions support ordered event/property-change routing, all/any conditions, explicit unknown values, precise decimal comparisons and bounded DAG validation. Goals and terminal exits are separate.
- Draft CAS and immutable versions protect active journeys. New entry is future-only; manual new cycles require an explicit command and reason.
- Tracking MATCHED commits and evaluation receipts are atomic. Receipt consumption, snapshot, evidence effect, transition and internal stage-entry outbox also commit together. Canonical event and new property-observation causes remain distinct.
- Concurrent SQLite clients, publication boundaries, pinned versions, independent enquiries/orders, duplicate payment facts, manual corrections, source generation changes, deletion and retention are covered by integration tests.
- All action plans captured in this slice are empty and tracking-only. Installing later automation cannot activate old stage entries. Real email delivery belongs to #39/#40.
- Blank, sales, ecommerce, event and subscription examples are editable configurations using the same evaluator. The API simulator never calls providers.
- Independent schema/service review identified and resolved generation corroboration, property-change deduplication and anonymous-backlog transaction sizing before PR creation.

- CI exposed an existing polling race in the social runtime stress test: all destinations could be successful before the aggregate post status committed. The test now waits for both completion conditions; the actual seven-destination worker/parallel-OAuth test passed after the correction.
