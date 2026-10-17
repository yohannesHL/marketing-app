# Funnel implementation sequence

Use [contracts v1](../../docs/funnels/contracts.md) as the shared boundary. User authorization covers creating, validating and merging one PR per issue in dependency order. Preserve unrelated work in the original checkout; implementation uses a managed worktree based on remote main.

| Issue | Deliverable | Verification |
| --- | --- | --- |
| #36 | Data/identity/source/campaign contracts, explicit decisions, examples and dependency reconciliation | Contract consistency, JSON examples, source links, required PR checks |
| #37 | Owned event inbox, source connections, identities/subjects, form/API/browser and Calendly/Shopify adapters, diagnostic API | Real isolated DB migrations, source authentication, source/owner isolation, replay/deduplication, reschedule/refund facts |
| #38 | Immutable custom definitions, deterministic rules, journey/history APIs and manual movement | Public service/API integration scenarios, branch/version/concurrency invariants |
| #39 | Owned email campaigns/revisions, Resend sender adapter, membership reasons, local send records and shared suppression | Provider protocol fixtures, callback races, opt-out, sender/capability gating |
| #40 | Durable action/run/job execution, waits/timeouts, campaign cadence, pause/stop/recovery | Fake-clock and restart/concurrent-worker tests, honest uncertain outcomes, permission checks |
| #41 | Accessible custom builder, source inspector, templates, sample simulator and activity views | Real app journeys, keyboard/mobile checks, no-send simulation and draft/publish behaviour |
| #42 | Explicit cohort/branch reporting, sales and ecommerce end-to-end evidence and operations | Reconciled financial/reporting facts, integration journeys, documented outstanding live pilot gates |

Before each merge, inspect the final diff, run appropriate focused checks and required CI, attach the PR to this chat, and verify merge status. Branch subsequent work from the newly merged main. Keep provider writes disabled without actual setup and an authorized recipient/account; fixture results must be named as fixtures.

Do not broaden old ad/social capabilities accidentally. Source credentials, marketing eligibility and current stage are checked at each applicable boundary. Do not reduce both-journey/custom-funnel requirements to fixed templates or a sales-only release.
