# Social publishing readiness tracker

Owner handoff: [integrated release packet](social-release-packet.md), [setup/scopes/callbacks/costs](social-publishing-setup.md), and [worker operations](social-delivery.md). Engineering, mock verification, provider approval and actual customer publication are separate gates. Paid advertising permissions remain separate from SOCIAL grants.

| Issue | Engineering deliverable | Recorded state |
| --- | --- | --- |
| #9 | Owner setup and review handoff | Guide merged; actual owner app/review/recording inputs remain unperformed |
| #10 | Revision/media/delivery records, durable scheduling/recovery | Implemented and merged; live deployment/restore exercise pending |
| #11 | Separate Social composer/review/calendar/status UI | Implemented and merged; all-destination evidence and exact-head merge gate recorded below |
| #12 | YouTube authorization/Shorts upload/status/recovery | Implemented and merged with mock evidence; owner/live gates open |
| #13 | Facebook/Instagram authorization/media/publishing/Page credentials | Implemented and merged with mock evidence; owner/live gates open |
| #14 | TikTok creator controls/Direct Post/rotating renewal | PR #30 head `18ef4c2`: 270 backend checks and required CI green; owner scheduled-flow audit/live gates open |
| #15 | LinkedIn member/organization permissions/publishing | PR #31 head `471d446`: 321 backend checks and required CI green; owner read/product approvals/live gates open |
| #16 | X publishing/renewal/API allocations/local quote | PR #32 head `826f015`: required CI green; 378 backend checks and ten fresh migrations passed; targeted X checks 57/57; owner billing/live gates open |
| #17 | All-destination journeys/isolation/recovery/release evidence | PR #33 head `c42be35754a16f1378ea5758feef51f4ba74cc46`: backend 405/405 and typecheck passed; eight actual storage checks passed independently against matching frozen source. All seven required CI checks must be green on the exact QA/handoff head before merge; see PR #33 |
| #18 | Integrated engineering and owner handoff | Packet prepared; exact-head seven-check merge gate applies; remains open for unperformed owner/live gates |

Configured implementations can be available in explicit mock/live mode. Publication is disabled by default and additionally requires an approved provider allowlist and the customer's exact reviewed revision/destinations. Configuration or a successful connection cannot establish provider approval. The user chose Mockoon validation instead of supplying live staging credentials. Workers capture configuration and encryption keys at startup: stop affected continuous workers before changing write switches/allowlists, then reload/restart web and workers with the disabled configuration. Secret-store edits alone do not stop existing processes. Before encryption rotation rewrites records, every instance must have reloaded the combined old-and-new keyring; retain old keys until records and retained backups no longer require them.

| Destination | App/product/review approval | Actual customer/asset access | Console quota/billing | Live publication and cleanup |
| --- | --- | --- | --- | --- |
| YouTube Shorts | Not supplied | Not validated | Not verified | Not performed |
| Facebook Pages | Not supplied | Page tasks not validated live | Not verified | Not performed |
| Instagram professional | Not supplied | Page linkage/professional eligibility not validated live | Not verified | Not performed |
| TikTok | Intended scheduled Direct Post audit not supplied | Creator/private or audited eligibility not validated live | Not verified | Not performed |
| LinkedIn | Member/organization/read approvals not supplied; new r_member_social requests closed | Organic author actions not validated live | Not verified | Not performed |
| X | Owner developer configuration not supplied | Customer identity/access not validated live | Credits/rates/console caps not supplied | Not performed |

Before public access, retain permission-specific recordings, actual pilot roles/identities, approved media/audience/time, immutable app revision, real provider receipts/status, partial/cancel/uncertain-outcome evidence and external cleanup. Do not include tokens, secret values, private signed URLs or unrelated customer content. Publishing must not send direct messages, automate engagement or activate a paid campaign.

The [release packet](social-release-packet.md) records exact PR #33 checks and earlier scoped browser results, including the LinkedIn WebKit retry. The reproduced worker database timeout was corrected with idle preflight and bounded local claim-only retry; partial startup cleanup and bounded screenshot capture were also verified. Linux diagnostics identified a rejected COMMIT and retained native transaction blocking later reads/writes. Actual failing regressions confirmed the cause. Persistent local files now use explicitly owned built-in Node SQLite connections, retaining existing journal mode, finite per-connection waits and write intent before callbacks. Only exact BUSY code 5 on an active, uncommitted transaction permits bounded retries of that same COMMIT; no statement, callback or provider request repeats. Finished or failed transactions dispose their physical connection; remote/memory handling remains unchanged. The eight storage regressions pass, including value/URI compatibility and detached-holder preservation. Node 24.16.0 or a later Node 24 release is required; no WAL policy is introduced. For each QA/handoff PR, require all seven checks on the exact current head before merge: security/migrations/typecheck, Chromium/Firefox/WebKit app journeys and Chromium/Firefox/WebKit social-delivery journeys. Current results are linked from [PR #33 checks](https://github.com/yohannesHL/marketing-app/pull/33/checks); earlier-head/local passes do not substitute for this gate. Mock evidence does not establish a live pilot, review, upload or publication. [Issue #18](https://github.com/yohannesHL/marketing-app/issues/18) remains open while owner/live gates are unperformed; the QA/handoff exact-head merge gate is independently required.
