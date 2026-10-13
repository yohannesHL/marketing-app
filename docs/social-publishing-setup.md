# Social publishing setup and release scope

LaunchPad will offer two marketing categories: Paid advertising and Social publishing. The first social release includes YouTube Shorts, Facebook Pages, Instagram professional accounts, TikTok, LinkedIn, and X. All are in scope; each needs its own validated publishing capability before the release is considered complete.

This is planned work, not an implemented connection or publishing feature. Automation means scheduling customer-reviewed content for publication. Account connection alone never publishes anything. Direct messages, automated engagement, autonomous content generation, and recurring repost rules are outside this first scope.

## Customer experience

| Paid advertising | Social publishing |
| --- | --- |
| Create campaign | Create post |
| Choose ad account, goal, audience, budget and creative | Choose social profile/channel, content, per-platform caption and publishing time |
| Review and launch campaign | Review and publish now or schedule |
| Campaign delivery, spend and ad results | Calendar, drafts, delivery status and links to published posts |

Use distinct navigation and creation flows. Marketing type must be explicit in stored records, filters and routes; it is not a campaign objective. Existing campaigns remain paid advertising. Shared connections show capabilities separately, such as Ads access and Publishing access. Request extra permissions when the customer enables the relevant capability.

The social composer previews each destination independently and allows platform-specific content. An unsupported format or unapproved account produces an actionable error before scheduling. Partial success remains visible per destination and retrying one failure does not repost successful destinations.

## Initial publishing formats

- YouTube: Shorts only; square or vertical video up to three minutes under the current classification rules. Upload through the YouTube Data API; there is no separate Shorts upload endpoint. YouTube determines classification and delivery after upload.
- Facebook: Page text/image posts and Reels. Personal profiles are not publishing destinations in this release.
- Instagram: professional-account image posts and Reels. Choose and document the login model; Facebook Login requires the appropriate linked Page, while Instagram Login has a different permission model.
- TikTok: short video through Content Posting API Direct Post, subject to app approval and creator-specific settings.
- LinkedIn: member and organization text/image/video posts, subject to the relevant product access, scopes and organization roles.
- X: text/image/video posts using the X API, subject to the account's supported media and API access.

These are acceptance targets. Implementers must validate current media limits, permissions and account eligibility. Do not treat ad-platform support as evidence of organic publishing support.

## What Yohannes needs to set up

### Shared prerequisites

- [ ] Confirm staging and production HTTPS domains, business details and support contact.
- [ ] Approve privacy, terms, retention, deletion and publishing-consent wording covering social content and scheduled jobs.
- [ ] Own the developer apps/projects and provide a pilot destination for every platform, including the appropriate channel/Page/profile administrator.
- [ ] Register exact callback URLs supplied by engineering after the implementation contract is agreed.
- [ ] Put secrets in the agreed deployment secret store. Share app IDs, account/channel IDs, approval status and secret references, not tokens or client secrets in issues or chat.
- [ ] Submit platform reviews using engineering's working demo, test login and permission-specific recordings.
- [ ] Supply approved pilot media and confirm the visibility/time of any real publishing test before it runs.

### YouTube Shorts

- [ ] Enable YouTube Data API v3 in a business-owned Google Cloud project. The Google Ads API does not provide publishing access.
- [ ] Create/configure a web OAuth client and consent setup with upload permission; add only the additional scopes required for implemented channel/status operations.
- [ ] Supply a pilot YouTube channel and a user who can authorize it. Verify the actual selected channel rather than inferring it from the Google email.
- [ ] Complete applicable OAuth verification and YouTube compliance/quota processes. Record the current console access and quota status; verify current upload visibility behavior instead of relying on older audit restrictions.

Engineering supplies resumable upload, channel verification, Shorts media validation, explicit visibility/audience/disclosure inputs, processing checks and schedule/cancel behavior. Set visibility explicitly rather than trusting API defaults.

Sources: [video upload API](https://developers.google.com/youtube/v3/docs/videos/insert), [Shorts classification](https://support.google.com/youtube/answer/15424877?hl=en), [YouTube compliance and quota](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits).

### Facebook and Instagram

- [ ] Configure the Meta app for Page/Instagram publishing separately from Marketing API access. Reuse the same business-owned app only where the selected products and login flows support it.
- [ ] Provide a pilot Facebook Page, an Instagram professional account, and users with the necessary asset roles.
- [ ] For the selected login flow, request the required Page publishing/discovery and Instagram publishing scopes. Engineering must supply an exact permission matrix; do not mix scopes from different login models.
- [ ] Complete the applicable business verification and permission review for external customer accounts; register deletion and deauthorization handling.

Engineering supplies Page/profile selection, token lifecycle, media processing/container checks and publication confirmation. Ads access does not automatically grant permission to publish organic content.

Sources: [Meta Facebook API](https://www.postman.com/meta/facebook/documentation/r56bjfd/facebook-api), [Meta Instagram API](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api).

### TikTok

- [ ] Register a TikTok for Developers app with Content Posting API Direct Post and the required publishing scope, plus a pilot creator account.
- [ ] Register callbacks and verify media domain ownership when the chosen upload method requires it.
- [ ] Submit the app review/audit for the intended customer-facing scheduled publishing flow. Unaudited Direct Post clients have private-viewing restrictions.

Engineering must validate the scheduling design against the current required consent/privacy/disclosure UI, query creator capabilities, and track asynchronous results. Public automated posting remains blocked if the intended flow is not approved; upload-to-inbox requiring manual completion is not equivalent to completed automated publishing.

Sources: [Direct Post setup](https://developers.tiktok.com/docs/en/content-posting-api-get-started), [content sharing requirements](https://developers.tiktok.com/docs/en/content-sharing-guidelines).

### LinkedIn

- [ ] Create/configure the developer app and obtain the product access for the intended member and organization publishing features.
- [ ] Supply pilot member and company Page destinations with suitable roles.
- [ ] Request member posting and organization posting permissions only for supported features; complete review for organizational/community-management access as applicable.

Engineering must distinguish the publishing actor, validate organization roles, implement media uploads and use a supported version of the Posts API. Advertising API approval is not a substitute for the required social product access.

Source: [LinkedIn Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api).

### X

- [ ] Configure an X developer app for user-authorized post creation and the required media operations. Ads API approval does not cover this integration.
- [ ] Provide a pilot X account and the agreed credentials through the secret store.
- [ ] Arrange API credits/billing and choose a spending limit in the developer console. Do not assume organic publishing API calls are free.

Engineering supplies user authorization, supported media upload, publication results, rate-limit handling and clear quota/credit errors. Check current endpoint pricing before the pilot; do not hard-code cost assumptions into the customer UI.

Sources: [X post creation](https://docs.x.com/x-api/posts/create-post), [X API pricing](https://docs.x.com/x-api/getting-started/pricing).

## Scheduling and operational requirements

Engineering provides durable jobs that survive server restarts, explicit timezones with UTC storage, cancellation/rescheduling, per-destination results and retries that reconcile uncertain provider outcomes before sending again. Media access must remain valid when a job runs. The scheduler rechecks credentials and authorization at execution time.

Stopping a local job must not falsely claim to cancel content already scheduled at a provider. If native provider scheduling is used, implement provider-side cancellation and report failures. Disconnecting publishing should stop its pending jobs and explain any broader effect if revoking a grant also affects advertising.

## Release evidence

- [ ] Separate Paid advertising and Social publishing navigation, forms, statuses and records.
- [ ] No advertising or posting begins merely from connecting an account.
- [ ] All six destinations complete connect, compose, schedule, execute, status and recovery tests.
- [ ] Cross-customer isolation, duplicate delivery, worker restarts, timezone boundaries, media expiry and partial failures are tested.
- [ ] Real pilot evidence is recorded separately from mocked CI results; test publication is explicitly authorized for the target account and content.
- [ ] Platform approvals, API credits and account eligibility are tracked as external blockers, never disguised as implementation success.

Platform documentation checked on 13 October 2026. Verify requirements and prices again during implementation and review submission.

## Implementation tracking

- [Social publishing tracker](https://github.com/yohannesHL/marketing-app/issues/18)
- [Owner setup and approvals](https://github.com/yohannesHL/marketing-app/issues/9)
- [Publishing records and scheduling](https://github.com/yohannesHL/marketing-app/issues/10)
- [Marketing category UI](https://github.com/yohannesHL/marketing-app/issues/11)
- [YouTube Shorts](https://github.com/yohannesHL/marketing-app/issues/12)
- [Facebook and Instagram](https://github.com/yohannesHL/marketing-app/issues/13)
- [TikTok](https://github.com/yohannesHL/marketing-app/issues/14)
- [LinkedIn](https://github.com/yohannesHL/marketing-app/issues/15)
- [X](https://github.com/yohannesHL/marketing-app/issues/16)
- [Release verification](https://github.com/yohannesHL/marketing-app/issues/17)
