# Customer marketing progress

Status as of 17 October 2026: all connection/social implementation batches through PR #34 are merged. The owner excludes API keys and live verification from issue completion. See [current completion audit](../../docs/implementation-completion-audit.md); the dated progress entries below are historical.

| Issue | Outcome | Status | PR |
| --- | --- | --- | --- |
| [3](https://github.com/yohannesHL/marketing-app/issues/3) | feat: Add authenticated customer ownership and secure ad connection storage | Merged; 14 security regressions pass; fresh migrations/build pass | [#19](https://github.com/yohannesHL/marketing-app/pull/19) |
| [4](https://github.com/yohannesHL/marketing-app/issues/4) | feat: Connect real Google Ads customer accounts through OAuth | Merged; 37 exact-snapshot tests/build pass | [#20](https://github.com/yohannesHL/marketing-app/pull/20) |
| [5](https://github.com/yohannesHL/marketing-app/issues/5) | feat: Connect real Meta ad accounts through reviewed customer authorization | Merged; 60 exact-snapshot tests/build pass | [#21](https://github.com/yohannesHL/marketing-app/pull/21) |
| [6](https://github.com/yohannesHL/marketing-app/issues/6) | feat: Add Google and Meta connection settings and route requests to selected accounts | Merged; 82 exact-snapshot provider/security tests/build/browser review pass | [#22](https://github.com/yohannesHL/marketing-app/pull/22) |
| [7](https://github.com/yohannesHL/marketing-app/issues/7) | test: Verify Google and Meta connections and document a controlled pilot rollout | Merged; 88 backend tests and 27 app-browser cases pass; live checks unavailable | [#23](https://github.com/yohannesHL/marketing-app/pull/23) |
| [8](https://github.com/yohannesHL/marketing-app/issues/8) | epic: Enable real customer ad account connections for Google and Meta | Complete connection/read scope; external rollout separate | [#24](https://github.com/yohannesHL/marketing-app/pull/24) |
| [9](https://github.com/yohannesHL/marketing-app/issues/9) | docs: Document owner setup and approvals for all social publishing platforms | Complete owner setup guide and public policy previews | [#25](https://github.com/yohannesHL/marketing-app/pull/25) |
| [10](https://github.com/yohannesHL/marketing-app/issues/10) | feat: Add social publishing records and durable scheduled delivery | Merged durable scheduler; all-platform regressions pass | [#26](https://github.com/yohannesHL/marketing-app/pull/26) |
| [11](https://github.com/yohannesHL/marketing-app/issues/11) | feat: Distinguish Paid advertising and Social publishing throughout the UI | Merged composer/calendar; review-state follow-up fixed locally | [#27](https://github.com/yohannesHL/marketing-app/pull/27) |
| [12](https://github.com/yohannesHL/marketing-app/issues/12) | feat: Connect YouTube channels and publish scheduled Shorts | Merged; Shorts upload/status/recovery covered by Mockoon | [#28](https://github.com/yohannesHL/marketing-app/pull/28) |
| [13](https://github.com/yohannesHL/marketing-app/issues/13) | feat: Publish scheduled Facebook Page posts and Instagram content | Merged; all formats covered; Facebook/Instagram UI worker test passes | [#29](https://github.com/yohannesHL/marketing-app/pull/29) |
| [14](https://github.com/yohannesHL/marketing-app/issues/14) | feat: Connect TikTok creators and schedule approved Direct Post videos | Merged; creator consent, Direct Post and recovery covered | [#30](https://github.com/yohannesHL/marketing-app/pull/30) |
| [15](https://github.com/yohannesHL/marketing-app/issues/15) | feat: Publish scheduled LinkedIn member and organization posts | Merged; member and organization publishing covered | [#31](https://github.com/yohannesHL/marketing-app/pull/31) |
| [16](https://github.com/yohannesHL/marketing-app/issues/16) | feat: Publish scheduled X posts with API cost and quota handling | Merged; publishing, renewal and explicit cost limits covered | [#32](https://github.com/yohannesHL/marketing-app/pull/32) |
| [17](https://github.com/yohannesHL/marketing-app/issues/17) | test: Verify all social destinations and separation from paid advertising | Merged; seven-destination QA and three-browser CI passed | [#33](https://github.com/yohannesHL/marketing-app/pull/33) |
| [18](https://github.com/yohannesHL/marketing-app/issues/18) | epic: Add automated social publishing alongside paid advertising | Merged handoff; all seven CI checks passed; external rollout separate | [#34](https://github.com/yohannesHL/marketing-app/pull/34) |


## Decisions

- Work in a managed isolated checkout; preserve original files and database.
- Use Mockoon for external API testing, as requested.
- Keep ADS and SOCIAL grants separate and distinguish paid campaigns from social posts in the UI.
- Include all requested social platforms in the first release; surface provider approval blockers.
- Record mock and live evidence separately; no claim of actual customer/provider validation.

## 13 October validation

- Meta adds verified Business Login, paginated ad account discovery, fresh role checks and signed deauthorization/data deletion callbacks.
- Deletion preserves unrelated provider/mode history; replay fences protect consent started before revocation, including same-second timestamps.
- 59 backend tests pass against real local Mockoon HTTP services. No live provider pilot has been performed.

## Selected-account integration

- Sign-in and customer connection settings distinguish Ads and Publishing grants, show actual metadata and require explicit Google manager selection.
- Selected-account reads validate every supplied customer destination before any provider call; independent contexts and a final transaction prevent stale or deleted provider results from being saved.
- Concurrent same-provider accounts retain distinct bearer/account contexts; provider failures yield sanitized per-account outcomes.
- All 88 current backend tests pass (82 in #6; six pilot CLI tests reserved for #7); production build and fresh Prisma CLI migration deploy pass. Browser connect/select/read/reconnect/disconnect journeys pass in Chromium, Firefox and WebKit.
- Live campaign/asset writes remain disabled. The legacy advertising wizard is explicitly labeled a demo, and live mode cannot reach simulated create success.

## Controlled rollout QA

- All 27 active app journeys pass across Chromium, Firefox and WebKit; no skipped scenario is counted as passing evidence.
- The read-only pilot CLI was exercised against the actual temporary application and both Mockoon providers: two explicit selected accounts read successfully, mode mock, writes disabled.
- CI uses pinned official action revisions, fresh Prisma migrations, security tests and the same five app spec files across three browsers.
- Pilot live reads, write-probe idempotency, paused creation/cleanup and platform reviews remain explicitly unperformed. Connection-only readiness is the delivered scope.

## Paid release integration

- Individual PRs #20–#23 contain Google, Meta, selected-account UI/routing and controlled rollout QA. PR #22 exact-commit independent review passes all 82 tests, build/migrations and selected browser checks.
- The #8 handoff maps engineering evidence to owner-side prerequisites and records live/public/paused-write blockers explicitly.
- GitHub CI is running on the reviewed QA branch. This first five-issue batch remains unmerged until reviews and final CI checks pass.

## First batch merged

- PRs #20–#24 merged in dependency order; remote main revision `597ef390db07542fb34dd98815c58530f61c9c08`.
- Exact QA CI is green: [QA run](https://github.com/yohannesHL/marketing-app/actions/runs/38339210069). Final handoff CI is green: [release packet run](https://github.com/yohannesHL/marketing-app/actions/runs/38339508018). All four jobs pass, including three browser suites.
- Epic #8 remains open for owner/provider live and public-release gates. The original checkout and customer database remain untouched.
- Social owner guide freezes callback/configuration contracts while clearly marking provider implementations, actual recordings, public approvals and live publication pending.

## Social delivery implementation

- Immutable reviewed revisions, explicit destination variants, durable leases, encrypted upload progress and per-destination recovery are implemented for #10. Publication remains disabled until separately implemented provider registrations are enabled.
- Trusted media uploads verify actual PNG/JPEG/MP4 bytes and FFprobe metadata, restrict customer access and issue scoped expiring media links. Seven media regressions pass against actual files.
- Disconnect/reconnect/revocation hooks stop pending local social work while retaining honest outcomes for provider requests already sent. Operator key rotation includes encrypted resumable upload progress.
- The isolated application builds successfully and the #11 social UI is undergoing three-browser validation. No live provider pilot or actual platform review is claimed.

## Social UI verification

- Separate category navigation, saved social drafts, verified media previews, explicit destination variants, review before scheduling, a calendar and per-destination recovery actions are implemented.
- All three social journeys pass in Chromium, Firefox and WebKit. Mobile captions and desktop calendars were visually inspected; the captured fixture evidence is in `docs/evidence/social-ui`.
- CI now includes the social journey with the existing paid/customer journeys. The empty provider registry prevents enqueue and TikTok controls await fresh creator capabilities from its integration.
- Exact foundation revision `8c88ba1` contains no UI or YouTube SDK changes. All 135 foundation/backend checks and seven fresh migrations pass; independent findings have dedicated recovery regressions.

### YouTube integration — 13 October 2026

- PR #26 exact-head migration/security and all three browser jobs passed; independent review passed. PR #27 UI fixes also passed exact-head CI in all three browsers and independent review. Second batch remains unmerged until #12/#13 are ready.
- YouTube now has separate SOCIAL consent, verified single-channel discovery and fresh selection, encrypted resumable delivery, app-side scheduling and verified offline renewal after logout/expiry.
- Shared deselection immediately cancels only affected unsent social jobs. Authoritative known processing rejection retains its receipt and blocks another send. Targeted shared/YouTube suite: 67 tests passed, zero skips.
- Mockoon is the agreed testing environment. Production credentials, provider verification/quota and live pilot/cleanup remain owner gates; no live approval or publication is claimed.

- Full current #12 backend selection passed 164/164 (before new independent renewal-race tests). The connection and social browser selection passed21/21 across Chromium, Firefox and WebKit; fresh app build and typecheck passed. Mobile/desktop YouTube screenshots were inspected.
- Independent review reproduced concurrent renewal loser and retryable429 bugs; fixes passed both reviewer reproductions. The final regression suite also covers reconsent/disconnect/scope-loss and reusable-Google503 backoff.

### Meta social publishing integration — 13 October 2026

- YouTube PR #28 is attached, stacked on #27. Independent review fixes include real Mockoon token503/308 behavior; only Google reusable-refresh POSTs can safely retry. Latest head6210421 has35/35 targeted YouTube/renewal checks.
- #13 Meta SDK/adapter/routes/encrypted Page-store integration passed35/35 targeted checks. App wiring now enables independent Page/professional-profile connection discovery and selection; live publication remains separately disabled. Page-key rotation is included in the maintenance CLI.
- UI explicitly distinguishes FB Reel AI disclosure from IG Reel feed-sharing, clears obsolete format choices, and names an IG account by username when its display name is absent. Processing failure keeps authoritative receipts terminal without another publication attempt.
- Browser tests caught ambiguous Page/IG fallback names and WebKit navigation-prefetch errors during OAuth/sign-out. Names now use IG usernames; authenticated account-navigation links no longer prefetch across those session/provider transitions. Current browser rerun is underway.
- Production Meta review/business/consent and real pilot/cleanup remain owner gates; docs/meta-social-publishing-integration.md gives the exact operator/customer steps.

- Exact Meta runtime310a064 plus test-only54fa4ec passed208/208 backend checks and independent35/35 Meta checks/typecheck. Existing21 browser cases passed; corrected3 new Meta cases passed in Chromium, Firefox and WebKit. Mobile/desktop screenshots reviewed. The test locator now includes its accessible description rather than assuming an exact label.


### Second batch merged and TikTok integration — 13 October 2026

- PRs #25–#29 merged in dependency order after independent review and exact-head migration/security/three-browser CI. Main is `311cc199707bb9e61e025818a38130ea9dfa98cf`. Owner/provider approvals and real live pilots remain explicitly unperformed.
- TikTok now has separate SOCIAL consent, verified creator capabilities, explicit privacy/interactions/disclosures/music/posting consent, verified owned-media delivery and app-side scheduling. Mockoon remains the agreed external test environment.
- Rotating refresh credentials use a durable shared lease, actual refresh expiry, per-request ownership/generation checks and a single persisted winner. Two independent SQLite clients proved writer coordination; ambiguous rotation requires reconnect rather than reusing an uncertain refresh token.
- Targeted tests cover actual TikTok SDK renewal after logout/expiry, safe first-request rate-limit retries, actual refresh lifetime during scheduling, scope/subject loss and concurrent worker adoption. Exact isolated app/browser validation follows; no unrun journey is counted as passed.


### LinkedIn integration — 13 October 2026

- Separate member and organization SOCIAL authors use explicit approved scopes, actual token introspection and current organic author actions. Existing approved restricted member read access is required; new permission requests are closed according to the current provider FAQ.
- Preliminary isolated LinkedIn application passed315/315 backend checks and its3 member/organization browser cases without advertising requests or enqueue. Desktop/mobile screenshots were inspected.
- Independent review reproduced asynchronous media processing being terminalized before publication. Safe bounded polling now preserves the exact upload/parts/finalization plan and prevents re-upload; four real Mockoon/SQLite regressions pass. Existing unknown-finalization coverage now asserts read polling without another mutation.
- Approved MDP renewal uses the shared coordinator and real refresh expiry; a new guarded-request regression requires reconnect after a successful token exchange followed by a local429 failure. Owner approvals, real member/organization pilot evidence and external cleanup remain unperformed.


### X integration — 13 October 2026

- TikTok #30 finalhead18ef4c2 and LinkedIn #31 head471d446 passed exact-head migration/security and all three browser CI jobs. They remain open for the requested five-issue batch. LinkedIn exact backend321 passed; one local WebKit auth prefetch diagnostic required retry, then a focused no-retry rerun passed3/3.
- X connects separately with session-bound PKCE and explicitly approved identity-read cost allocations; cached selection is honestly labeled. Each billable worker request reserves against immutable reviewed delivery/owner/day/operation limits; renewal prefunds identity verification before rotating.
- Local owned draft quotes use official weighted text and operator-configured rates, distinguish possible renewal cost and expose no invented bill or credit balance. Customer caps use exact dollars and explicit AI/partnership decisions.
- Preliminary isolated backend378/378 passed. Independent review found a live SDK read-funding escape; the fix and three permanent no-network live-read regressions pass in57/57 X checks. Isolated browser build found incompatible named CommonJS text-validator exports; default import fixes it, with57/57 checks and typecheck passing again.
- New X journey passed3/3 in Chromium/Firefox/WebKit without retry, with inspected mobile/desktop screenshots and no build diagnostics. Synthetic rates, saved drafts and actual Mockoon HTTP do not establish live approval, credits, billing, publication or cleanup.

### All-platform release QA — 13 October 2026

- TikTok #30, LinkedIn #31 and X #32 have exact-head migration/security and three-browser CI passing. This five-issue batch remains unmerged pending QA and owner handoff.
- Seven actual-SDK Mockoon matrix checks cover every destination, independent customer ownership, advertising/social separation, durable known/unknown outcomes, rate/credit failures and scheduling. Two additional failure/abort regressions verify that partially started provider servers and temporary files are cleaned up.
- The dedicated app/continuous-worker journey passed individually in Chromium, Firefox and WebKit with fresh databases and provider fixtures, zero retries: seven destinations each published once, followed by future scheduling/rescheduling/cancellation without another provider submission. Inspected mobile/desktop evidence exposed and verified a correction to wrapping long receipt labels and creator versions.
- A separate setup-abort process regression verifies provider children are reaped before the web app starts. A real independent SQLite writer held for eight seconds did not kill the worker; a subsequently reviewed X post succeeded once.
- Exact Firefox and CI Chromium/Firefox reproduced the earlier worker shutdown with Prisma P1008. The installed libSQL adapter maps SQLite BUSY to that timeout code. Claiming now obtains write intent before reading and retries only known local transaction contention, with four attempts and no provider HTTP in that region. Six regressions verify pre-callback timeout, exhaustion, committed-but-lost lease results, structured driver errors and unknown-error rejection; all passed. Corrected exact browser/CI validation follows.
- An independently reproduced missing-launcher failure stranded five ready mock servers. The bootstrap now handles child launch errors and reaps all owned resources; its actual no-npm regression passed independently. Browser evidence uses bounded viewport/focused screenshots to respect WebKit image-size limits while retaining every publication and overflow assertion.
- A further idle-process probe exposed contention with connection/sign-in writes when no delivery existed. Idle polling now uses a non-authorizing autocommit hint and opens a writer transaction only for eligible work or expired leases; the transaction rereads every fence with fresh time bounds. The expanded seven-test regression passed, including ten actual OAuth/selection journeys with zero claim transactions across normal and reconciliation polling.
- A heavier active-process probe reproduced SQLite BUSY during customer reads, connection writes and worker checkpoint bookkeeping. The shared local adapter now preserves the existing journal mode, sets a finite 100 ms timeout on each physical connection, and acquires write intent before transaction callbacks. Only a rejected BEGIN can retry; its poisoned connection is discarded, including after exhaustion. No callback, query, commit or provider request is replayed. All 57 existing transaction callbacks were independently surveyed and contain local database/CPU work.
- Three real storage regressions passed: connection turnover and memory/file URI compatibility; finite blocked BEGIN with zero callback execution and one later successful write; and the actual continuous CLI with five concurrent OAuth/selection journeys and 95 owned status reads while all seven destinations publish once. No customer API errors, worker shutdown or duplicate submissions occurred. Final immutable-head backend/browser/CI validation follows.
- No live provider credentials, approvals, credits, spending or publication were used. The final owner release packet retains those external gates explicitly.
- Linux CI diagnostics subsequently identified a rejected web COMMIT followed by persistent BUSY reads. An independent real-driver regression reproduced the retained failed-commit handle blocking later transactions. Persistent local files now use explicitly owned built-in Node SQLite connections while preserving Prisma/libSQL mapping, existing journal mode and remote/memory handling. Package engines require Node 24.16.0 or later within Node 24.
- Only exact SQLite BUSY code 5 on a still-active, uncommitted transaction permits four yielded retries of the same COMMIT. Callbacks, SQL statements and provider requests never replay; completion or terminal failure disposes the physical transaction, preserving the original error. BEGIN-only acquisition retry remains before callbacks; reconnect leaves other detached transactions intact.
- Eight actual storage checks passed independently, including exhausted COMMIT/later write, transient reader release, a deferred constraint error with unchanged identity, same-client detached-holder preservation, binary/integer/row/URI compatibility and the original all-seven concurrent publishing stress. The independently reproduced boolean integer-mode mismatch has a permanent regression and is corrected. Final exact-head backend/browser/CI verification follows.

### Integrated Social owner handoff — 13 October 2026

- The release packet unifies callback registration, platform products/permissions, actual approval/access status, server secret references, customer provisioning and the seven-kind publication allowlist. It distinguishes app-side scheduling from native provider schedules and advertising grants from SOCIAL consent.
- Operations require the shared absolute SQLite/media paths and Node 24.16.0 or later within Node 24, supervised workers, stopping affected workers before disabling configuration, and reloading combined keyrings before encrypted-record rotation. Controlled status reconciliation never runs the continuous loop with temporary write-enabled settings.
- QA head c42be35754a16f1378ea5758feef51f4ba74cc46 passed 405 backend checks and typecheck; eight actual storage regressions and the source correction were independently reviewed. Each QA/handoff head still requires all seven CI checks before this third five-issue batch merges. Real provider registration, reviews, customer pilots, credits/spending/publication and external cleanup remain unperformed owner gates.
