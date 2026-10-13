# Customer marketing implementation

Deliver individual PRs for issues #4–#18. Review and merge five at a time in dependency order. Issue #3 is a separately reviewed prerequisite because the local app and security foundation are unpublished.

## Batch 1: paid advertising (#4–#8)
Google and Meta authorization/discovery; signed-in connection management and account-specific execution; deterministic provider QA and paused campaign checks; paid release integration.

## Batch 2: social publishing groundwork (#9–#13)
Owner setup documentation; durable approved posts and scheduling worker; distinct paid/social UI; YouTube Shorts; Facebook and Instagram publishing.

## Batch 3: remaining social platforms and release (#14–#18)
TikTok Direct Post; LinkedIn member and organization posts; X posts/media; cross-platform journey and scheduling QA; social release integration.

## Validation
Use Mockoon HTTP APIs with provider-shaped OAuth, identity, discovery, upload, publish, status and error fixtures. Use temporary databases and generated test keys. Test tenant isolation, one-time state, expired grants, refresh races, partial outcomes, duplicate suppression and cancellation. Build and exercise browser journeys.

The user authorized Mockoon instead of live pilot access on 2026-10-13. Mock evidence completes local integration validation; real approvals, actual provider access, live campaign writes and public publication remain unverified and disabled until configured. Keep those requirements visible in release checklists.
