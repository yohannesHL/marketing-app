# Social publishing readiness tracker

Owner handoff: [setup, scopes, callbacks and costs](social-publishing-setup.md). Shared security is implemented and verified; Ads and Publishing permissions remain separate. The first release includes all six requested destinations. A platform's API client, customer authorization, scheduling, provider approval and actual publication evidence are separate gates.

| Issue | Engineering deliverable | Current state |
| --- | --- | --- |
| #9 | Owner setup and review handoff | Guide verified against current primary sources; recordings and live owner/provider inputs pending |
| #10 | Revision/media/delivery records, durable scheduling, recovery | In progress |
| #11 | Separate Social navigation, composer, review, calendar and statuses | In progress |
| #12 | YouTube channel authorization and Shorts upload/status/cancel | Pending |
| #13 | Facebook Page and Instagram authorization/media/publishing | Pending |
| #14 | TikTok creator controls and audited Direct Post | Pending |
| #15 | LinkedIn member/organization permissions and publishing | Pending |
| #16 | X authorization/media/publishing and credit budgets | Pending |
| #17 | All-destination mock journeys, restart/isolation/recovery and release evidence | Pending |
| #18 | Integrated release handoff with all destinations and external gates | Pending |

All runtime publishing capabilities are currently unavailable. Owner app registration can begin with the documented callback contracts; the guide explicitly identifies those routes as planned until their implementations merge. The user chose Mockoon validation instead of supplying live staging credentials. No app approval, reviewer recording, live publication, upload or platform audit is claimed.

Before public access, retain permission-specific recordings of the actual supported customer journey, verified pilot destinations/roles, approved media/time/visibility, real provider IDs/status, cancellation/uncertain-outcome evidence and the owner console approval/quota/billing state for each platform. Publishing must not send direct messages, automate engagement or activate a paid campaign. X API credit costs and TikTok's required consent/audit controls are part of the owner handoff.
