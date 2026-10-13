# Customer marketing progress

Status: prerequisite #3 merged; Google #4 reviewed in PR #20; Meta #5 reviewed in PR #21; #6 connection UI/routing validated; #7 controlled rollout QA prepared.

| Issue | Outcome | Status | PR |
| --- | --- | --- | --- |
| [3](https://github.com/yohannesHL/marketing-app/issues/3) | feat: Add authenticated customer ownership and secure ad connection storage | Merged; 14 security regressions pass; fresh migrations/build pass | [#19](https://github.com/yohannesHL/marketing-app/pull/19) |
| [4](https://github.com/yohannesHL/marketing-app/issues/4) | feat: Connect real Google Ads customer accounts through OAuth | Implemented and independently reviewed; 37 tests and build pass | [#20](https://github.com/yohannesHL/marketing-app/pull/20) |
| [5](https://github.com/yohannesHL/marketing-app/issues/5) | feat: Connect real Meta ad accounts through reviewed customer authorization | Implemented and reviewed; 60 exact-snapshot tests/build pass | [#21](https://github.com/yohannesHL/marketing-app/pull/21) |
| [6](https://github.com/yohannesHL/marketing-app/issues/6) | feat: Add Google and Meta connection settings and route requests to selected accounts | Implemented; 82 provider/security tests, build and three-browser journey pass; awaiting review | Pending |
| [7](https://github.com/yohannesHL/marketing-app/issues/7) | test: Verify Google and Meta connections and document a controlled pilot rollout | Six read-only pilot CLI regressions and CI/rollback guide prepared; live checks remain unavailable | — |
| [8](https://github.com/yohannesHL/marketing-app/issues/8) | epic: Enable real customer ad account connections for Google and Meta | Planned | — |
| [9](https://github.com/yohannesHL/marketing-app/issues/9) | docs: Document owner setup and approvals for all social publishing platforms | Planned | — |
| [10](https://github.com/yohannesHL/marketing-app/issues/10) | feat: Add social publishing records and durable scheduled delivery | Planned | — |
| [11](https://github.com/yohannesHL/marketing-app/issues/11) | feat: Distinguish Paid advertising and Social publishing throughout the UI | Planned | — |
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
