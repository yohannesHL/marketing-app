# Funnel implementation progress

Status: #36–#38 implementation merged; #39 owned email campaigns in progress. User authorized sequential PR creation and merges for #36–#42.

| Issue | State | Evidence |
| --- | --- | --- |
| #36 | Merged | [PR #43](https://github.com/yohannesHL/marketing-app/pull/43), commit `cfabf9d`; all required CI passed |
| #37 | Implementation merged; live evidence pending | [PR #44](https://github.com/yohannesHL/marketing-app/pull/44), commit `c9b1649`; all required CI passed; actual provider/pilot evidence remains open |
| #38 | Merged | [PR #45](https://github.com/yohannesHL/marketing-app/pull/45), commit `293c91c`; all 14 CI jobs passed; 490 security tests pass |
| #39 | Implementation ready for PR validation | Resend adapter, owned campaign revisions/membership, recipient policy and durable explicit send path; live pilot pending |
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

- A later CI run exposed transient read failures during the real social worker concurrency test. A deterministic exclusive-lock reproduction confirmed that a synchronous native read exhausted its 100 ms wait before the blocking process could release. The three deterministic regressions passed after bounded retries were restricted to SQLite-authorizer-confirmed autocommit SELECTs. All 11 storage tests, including the seven-destination concurrency test, passed. The original CI did not enable SQLite diagnostics, so this is a reproduced contention defect rather than proof of the exact original exception. Transaction callbacks and provider operations remain non-replayable.

## Issue #39 implementation evidence

- Sixteen scoped email/campaign tables preserve the legacy paid campaign model. Fresh migration, populated legacy upgrades, immutable definitions and direct ownership/uniqueness checks pass.
- Resend supports explicit single-message delivery, sender/webhook readiness, signed callbacks and positive known-ID reconciliation. Its declared capabilities exclude remote sequence enrollment, reply detection and provider scheduling.
- Campaign membership has a stable subject/contact scope and independent reasons. Draft CAS, pinned revisions, separate enrollment/dispatch controls and report-only stage links are covered by real SQLite integration tests.
- One encrypted frozen request, idempotency key and persisted attempt precede every send. Unknown acceptance holds its scope and cannot be resent or moved to another provider. Callback-before-response recovery and late acceptance after cancellation/deletion retain honest outcomes.
- Explicit category consent, global/category suppression, one-click unsubscribe and deletion apply across duplicate addresses and connections without merging business identities. Read-only unsubscribe GET and session/Origin management boundaries pass HTTP tests.
- Bounded retention keeps fingerprints/policy tombstones and unresolved-effect evidence. Temporal send windows cover repeated/skipped times, weekday rollover, exact endpoints and expiry.
- Independent reviews found and fixed deletion while submitting, callback privacy restoration, receipt redaction constraints, declared-versus-emitted tracking properties, contradictory provider mappings, and retention of queued negative-policy evidence. Fixture API/provider/campaign/delivery/schema/timing checks cover 60 passing cases; the final full regression run passed all 550 tests. App TypeScript and fresh/legacy migration checks also pass.
- [Email setup guide](../../docs/funnels/email-setup.md) documents setup order, routes, gates, workers, recovery, timing and privacy. The receipt worker performs no automatic sends in this slice; #40 owns automation through the same send identity.
- Actual live account/domain/webhook configuration, an authorized pilot recipient and real callback proof remain pending. Implementation checks do not satisfy that acceptance item.
