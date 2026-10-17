# Funnel implementation progress

Status: #36–#42 implementation complete and locally validated. PR merge/check history is recorded in the linked GitHub issues; actual provider/pilot verification remains pending. User authorized sequential PR creation and merges for #36–#42.

| Issue | State | Evidence |
| --- | --- | --- |
| #36 | Merged | [PR #43](https://github.com/yohannesHL/marketing-app/pull/43), commit `cfabf9d`; all required CI passed |
| #37 | Implementation merged; live evidence pending | [PR #44](https://github.com/yohannesHL/marketing-app/pull/44), commit `c9b1649`; all required CI passed; actual provider/pilot evidence remains open |
| #38 | Merged | [PR #45](https://github.com/yohannesHL/marketing-app/pull/45), commit `293c91c`; all 14 CI jobs passed; 490 security tests pass |
| #39 | Implementation merged; live evidence pending | [PR #46](https://github.com/yohannesHL/marketing-app/pull/46), commit `e0b6d7d`; all 14 CI jobs and 550 local tests passed |
| #40 | Merged | [PR #47](https://github.com/yohannesHL/marketing-app/pull/47), commit `68f0425`; all 14 CI jobs passed, 616 local regressions plus 26 tests for the final simulator correction |
| #41 | Merged | [PR #48](https://github.com/yohannesHL/marketing-app/pull/48), commit `3ed307b`; all 14 CI jobs passed, 634 backend tests and nine browser scenarios per engine |
| #42 | Implementation complete; live evidence pending | Version/cohort reporting, stage board, explicit source handoffs; 653 backend tests and 36 production browser scenarios pass |

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


## Issue #40 implementation evidence

- Published explicit `EMAIL_ENROLL`/`EMAIL_STOP` stage actions capture immutable transition plans. Separate funnel enrolment/dispatch controls default to false; historical tracking-only outboxes and old manual memberships retain no new automatic authority.
- The consumer replaces immediate adjacent-stage reasons before settling shared memberships, including accumulated outboxes. Stable campaign/scope identity and the first pinned campaign revision survive association changes. Delayed replacement cannot restart a closed cycle; independent manual and other-journey reasons survive a local stop.
- Explicit owner/session/Origin-protected membership start records one immutable command authorization. A new stage-created membership can seed its first step, but attaching a stage reason to an existing manual membership reports that explicit start is required. Workers derive authority from persisted executions and leases, never a fabricated browser principal.
- IMMEDIATE/DURATION/DATE/EVENT waits preserve logical anchors, original LIVE match availability, fixed expiry and explicit timeout outcomes. CONTACT campaigns cannot publish EVENT waits; a same-address enquiry cannot satisfy another subject's wait. Atomic continuation and the existing send ledger prevent duplicate intent creation after restart.
- Send/refresh leases are durable and bounded. An interrupted submission becomes UNKNOWN, never a fresh send; known retryable rejection retains its body/key and retry limits. Positive readback preserves actual acceptance without reviving stopped work, and readiness rotation invalidates stale worker authority.
- Independent review reproduced a dispatch gap after a stop condition evaluated UNKNOWN and its receipt was consumed. The fix retains an immutable owned event/stage/journey-revision/occurrence snapshot on each new evaluation effect and fences applicable reasons with `STOP_CONDITION_UNKNOWN`. The original reproducer now remains blocked with zero pending receipts. Older or unrelated evidence cannot clear that hold; same-millisecond clearance remains deliberately conservative.
- All nine direct automation schema checks passed, including populated legacy migration, preservation of previous triggers/indexes, owned bindings, immutable terminal/redaction paths, original LIVE event evidence, fixed clocks, explicit command authority and account-deletion cascades. Prisma validation/client generation and a fresh actual deployment of all 14 migrations passed with no foreign-key violations.
- Focused service tests cover concurrent consumers, stage/goal cancellation, CONTACT backlog fences, shared reasons, explicit start, waits, lease recovery, readiness, deletion and retention. Full regression passed 616/616 tests. A final historical-goal simulation correction passed all 26 affected API/rules tests; app and strict worker/test TypeScript checks and whitespace validation pass. All 14 CI jobs passed on PR #47 before merging.
- A real Node 24 worker subprocess test refreshes stale sender readiness and sends once after session deletion, then performs no HTTP on two subsequent process restarts. Legacy unstarted pending sends remain untouched and worker output contains no credentials, message content or recipient data.
- [Automation setup](../../docs/funnels/automation-setup.md) and the updated [email setup](../../docs/funnels/email-setup.md) document diagrams, controls, timing, workers, APIs, simulations, current recovery limits and rollout. PR #47 merged at `68f0425`. Actual LIVE delivery validation remains pending.
- Live provider/domain/webhook configuration, an authorized integrated recipient pilot and real callback correlation remain pending. The visual builder and reporting work remain separate in #41/#42.

## Issue #41 implementation evidence

- Custom React Flow canvas and keyboard form editor use the same bounded definition DSL, editable templates, explicit routing order, report-only campaign links and separately authorized actions. Local drafts survive CAS conflicts; publication review and automation activation fence the visible revision/version.
- Owned source/event/contact inspectors distinguish configuration, receipt, matching and replay. Email setup, campaign editing, explicit sequence start and uncertain delivery recovery expose the existing service contracts. Pinned journey history keeps enquiries/orders and cycles separate; audited manual correction rejects a newer cycle or revision.
- Full backend/security regression passed 632 tests. Final activation-version fencing passed all 12 affected inspector/automation API tests, including one additional test. App TypeScript, production build and whitespace checks pass.
- Eight production Chromium journeys pass against a disposable migrated database and loopback provider with LIVE transport disabled. Desktop, 320px/390px and light/dark screenshots were inspected; keyboard editing, conflicts, no-effect simulation, source recovery and separate journey histories pass. The existing Chromium, Firefox and WebKit app-journey CI jobs also run the isolated funnel suite after the existing suite.
- [Builder guide](../../docs/funnels/builder-guide.md) records scope, diagrams, controls, setup, verification and known limits. These are fixture results; live provider and authorized recipient evidence remain pending.

- The GitHub connection cannot modify workflow files. The existing CI entry point runs the funnel suite in each browser job; workflow permissions and job definitions remain unchanged.

- PR #48 CI passed all 633 backend/security tests and the Chromium/WebKit workspace suites. Firefox revealed a fractional native number-step mismatch blocking valid seven-day email durations; the input now permits precise numeric entry while the campaign validator retains whole-second bounds. Sign-in controls stay disabled until handlers attach, with a delayed-script regression. The eight original production Firefox scenarios pass after these fixes; the added delayed-script test also passes in a focused production run, including exact login body and supported deep-link return.

- The corrected head passed all nine browser scenarios in Chromium, Firefox and WebKit CI. One parallel CI security run exposed an intermittent existing social/OAuth stress failure (all seven deliveries succeeded, one LinkedIn operation returned INTERNAL_ERROR). The same stress passed focused and full local runs. Added test-only bounded/sanitized API/native SQLite boundary diagnostics, without changing storage execution or adding retries; full regression passed 634/634 and final focused storage tests passed 12/12. A separate first-read-under-exclusive-lock probe reproduces SQLITE_BUSY before authorizer classification, but is not evidence of the exact CI exception; no speculative prepare retry was added.

- Diagnostic-head CI passed both security runs, Chromium and Firefox. WebKit then reproduced interrupted Next.js RSC prefetch exceptions on quick funnel-list navigation. The narrow correction disables speculative loading for the demonstrated FunnelLayout/FunnelList links; AccountNavigation already had that policy. A real-network regression failed on the old bundle and passes after the change, with the global browser-exception assertion preserved. Fresh production WebKit passes all nine scenarios; app/spec TypeScript and whitespace checks pass.

- PR #48 merged at `3ed307b` after every final-head CI job passed, including Chromium/Firefox/WebKit. Issue #42 starts from that merged baseline.

## Issue #42 implementation evidence

- Results select one immutable published version and UTC entry cohort; current occupancy, unique reach, repeat cycles, goals, known exits and operational timing remain distinct. Financial facts deduplicate across cycles, retain exact decimal strings per currency and distinguish won value, paid cash and successful refunds. Unknown/partial/multiple attribution stays visible; configured campaign links remain separate from actual pinned memberships and explicitly attributed sends.
- A bounded read transaction returns a complete aggregate or an explicit limit error. The independent stage-board endpoint validates version/cohort/cursor scope, returns full totals and pages 50 cards with safe owned contact summaries. Historical journey links request their exact pinned version.
- Signed API references support explicit owned source handoffs, captured target generations, identity binding without email merging, deletion fences and conflict checks before new aliases. Manual matching cannot collapse same-store orders or copy canonical monetary evidence to another subject. Two integrated protocol proofs cover native form → two enquiries → independent nurture/reminder cancellation → recorded sale, and server checkout → verified paid order → repeated delivery → repeat purchase → successful refund.
- Independent service/UI/handoff review completed. Full regression passes 653/653; production browser suite passes 36/36 across Chromium/Firefox/WebKit, including 320px and light/dark views. Application and focused strict test TypeScript checks pass. Reporting reads leave provider counters and application state unchanged.
- Full regression exposed a pre-existing probabilistic Meta test: random Base64 ciphertext happened to contain a short numeric provider ID. The test now verifies the authenticated envelope, decryption, credential-free progress and wrong-context rejection; all 13 focused provider tests pass without changing production social code.
- [Reporting guide](../../docs/funnels/reporting-guide.md) supplies definitions, API contracts, diagrams and operating procedures. [Release evidence](../../docs/funnels/release-evidence.md) records controlled evidence and the still-pending real Calendly, Shopify and Resend pilot. Issues #37/#39/#42 retain those live requirements.

- Initial PR #49 CI passed both security/typecheck runs, all social checks and WebKit app journeys. Linux Chromium/Firefox exposed intrinsic date-control sizing in the new result filters: the 320px page grew by 1–3px. The old production bundle reproduced a larger overflow at 125% control text (345px page; 312px labels in a 254px grid). The fix gives the filter grid an explicit zero-minimum single column and allows its labels/select to shrink; strict normal/enlarged-text overflow checks remain in the browser suite. No overflow hiding or assertion tolerance is used.
- Fresh production verification after the filter correction passes all nine reporting scenarios across Chromium, Firefox and WebKit, including 125% control text and native date-field keyboard navigation; the original viewport assertion remains strict. The broader unchanged backend baseline remains 653/653, with a fresh full CI run required on the correction commit.
