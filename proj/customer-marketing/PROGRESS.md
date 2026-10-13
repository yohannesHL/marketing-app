# Customer marketing progress

Status: prerequisite #3 merged in PR #19; #4 in validation; #5 provider and #7 wizard QA work in progress.

| Issue | Outcome | Status | PR |
| --- | --- | --- | --- |
| [3](https://github.com/yohannesHL/marketing-app/issues/3) | feat: Add authenticated customer ownership and secure ad connection storage | Merged; 14 security regressions pass; fresh migrations/build pass | [#19](https://github.com/yohannesHL/marketing-app/pull/19) |
| [4](https://github.com/yohannesHL/marketing-app/issues/4) | feat: Connect real Google Ads customer accounts through OAuth | Implemented; 33 provider/foundation tests and build under validation | — |
| [5](https://github.com/yohannesHL/marketing-app/issues/5) | feat: Connect real Meta ad accounts through reviewed customer authorization | Planned | — |
| [6](https://github.com/yohannesHL/marketing-app/issues/6) | feat: Add Google and Meta connection settings and route requests to selected accounts | Planned | — |
| [7](https://github.com/yohannesHL/marketing-app/issues/7) | test: Verify Google and Meta connections and document a controlled pilot rollout | Planned | — |
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
