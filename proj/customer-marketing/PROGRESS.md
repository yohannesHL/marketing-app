# Customer marketing progress

Status: first five-issue batch #4–#8 reviewed and merged; social owner handoff #9 ready, durable delivery #10 and social UI #11 in progress.

| Issue | Outcome | Status | PR |
| --- | --- | --- | --- |
| [3](https://github.com/yohannesHL/marketing-app/issues/3) | feat: Add authenticated customer ownership and secure ad connection storage | Merged; 14 security regressions pass; fresh migrations/build pass | [#19](https://github.com/yohannesHL/marketing-app/pull/19) |
| [4](https://github.com/yohannesHL/marketing-app/issues/4) | feat: Connect real Google Ads customer accounts through OAuth | Merged; 37 exact-snapshot tests/build pass | [#20](https://github.com/yohannesHL/marketing-app/pull/20) |
| [5](https://github.com/yohannesHL/marketing-app/issues/5) | feat: Connect real Meta ad accounts through reviewed customer authorization | Merged; 60 exact-snapshot tests/build pass | [#21](https://github.com/yohannesHL/marketing-app/pull/21) |
| [6](https://github.com/yohannesHL/marketing-app/issues/6) | feat: Add Google and Meta connection settings and route requests to selected accounts | Merged; 82 exact-snapshot provider/security tests/build/browser review pass | [#22](https://github.com/yohannesHL/marketing-app/pull/22) |
| [7](https://github.com/yohannesHL/marketing-app/issues/7) | test: Verify Google and Meta connections and document a controlled pilot rollout | Merged; 88 backend tests and 27 app-browser cases pass; live checks unavailable | [#23](https://github.com/yohannesHL/marketing-app/pull/23) |
| [8](https://github.com/yohannesHL/marketing-app/issues/8) | epic: Enable real customer ad account connections for Google and Meta | Handoff merged; public/live gates remain open | [#24](https://github.com/yohannesHL/marketing-app/pull/24) |
| [9](https://github.com/yohannesHL/marketing-app/issues/9) | docs: Document owner setup and approvals for all social publishing platforms | Independent review and exact CI pass; owner review/recording/live gates tracked separately | [#25](https://github.com/yohannesHL/marketing-app/pull/25) |
| [10](https://github.com/yohannesHL/marketing-app/issues/10) | feat: Add social publishing records and durable scheduled delivery | In progress | — |
| [11](https://github.com/yohannesHL/marketing-app/issues/11) | feat: Distinguish Paid advertising and Social publishing throughout the UI | In progress | — |
| [12](https://github.com/yohannesHL/marketing-app/issues/12) | feat: Connect YouTube channels and publish scheduled Shorts | Planned | — |
| [13](https://github.com/yohannesHL/marketing-app/issues/13) | feat: Publish scheduled Facebook Page posts and Instagram content | Planned | — |
| [14](https://github.com/yohannesHL/marketing-app/issues/14) | feat: Connect TikTok creators and schedule approved Direct Post videos | Planned | — |
| [15](https://github.com/yohannesHL/marketing-app/issues/15) | feat: Publish scheduled LinkedIn member and organization posts | Planned | — |
| [16](https://github.com/yohannesHL/marketing-app/issues/16) | feat: Publish scheduled X posts with API cost and quota handling | Planned | — |
| [17](https://github.com/yohannesHL/marketing-app/issues/17) | test: Verify all social destinations and separation from paid advertising | Planned | — |
| [18](https://github.com/yohannesHL/marketing-app/issues/18) | epic: Add automated social publishing alongside paid advertising | Planned | — |

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
