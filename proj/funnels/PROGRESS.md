# Funnel implementation progress

Status: #36 contracts prepared for PR review. User authorized sequential PR creation and merges for #36–#42.

| Issue | State | Evidence |
| --- | --- | --- |
| #36 | Ready for PR | Contracts/examples reviewed; JSON/link checks, Prisma generation and TypeScript pass; required CI pending |
| #37 | Not started | Depends on #36 |
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
