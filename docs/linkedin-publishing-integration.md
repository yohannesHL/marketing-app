# LinkedIn member and organization publishing

This integration uses separate SOCIAL authorization, current Posts/Images/Videos APIs and app-side scheduled delivery. It does not use Advertising API authorization or boost content. Members and organizations have distinct selected author URNs; the provider verifies identity, token permissions and current organic organization actions before publishing.

## What the owner needs to set up

1. Create a business-owned developer app, associate the intended LinkedIn Page and register the exact HTTPS callback `APP_ORIGIN/api/connections/linkedin/callback`. Request the applicable Sign In with LinkedIn using OpenID Connect and Community Management products. Supply app ID, product approval state, permitted scopes, Page/member pilot identities and secret-store locations; never put secrets in tickets or browser configuration.
2. Member publishing needs `openid`, `profile`, `w_member_social` and **restricted `r_member_social`** for readback/reconciliation in this release. LinkedIn states that new requests for this permission are closed; member publishing here requires existing approved access. [Current access FAQ](https://learn.microsoft.com/en-us/linkedin/marketing/lms-faq). Write-only self-serve access cannot satisfy this implementation's confirmation requirement; the member remains visibly unavailable. Organization workflows need `openid`, `profile`, `w_organization_social`, `rw_organization_admin` and `r_organization_social`. Actual organic create and view-as-author actions must be approved for the authenticated member; a sponsored-content role alone does not prove organic permission. [Posts permissions](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api) and [organization authorizations](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-authorizations/organization-authorizations).
3. Set `LINKEDIN_SCOPES` to the exact JSON array actually approved for the app. `[]` leaves the integration disabled. Include both workflows only when both are approved; configured scopes and actual introspected grants must satisfy each destination independently. Do not add restricted permissions merely because they appear in a fixture.
4. Install `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET` on the server. Keep `LINKEDIN_MDP_REFRESH_ENABLED=false` unless LinkedIn actually grants programmatic refresh access through the Marketing Developer Platform. Ordinary access expiry requires reconnecting. Approved refresh uses the actual token/refresh deadlines, persists rotated credentials under the shared durable lease and never extends the original refresh lifetime. [Refresh eligibility and lifetime](https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens).
5. Record the approval evidence and an authorized pilot plan for **both** intended author types, including exact account, content, visibility, time, expected receipt and provider cleanup. None has been performed here. Keep the [readiness tracker](social-publishing-readiness.md) open until those gates are satisfied.

The client pins `LinkedIn-Version: 202609` with `X-Restli-Protocol-Version: 2.0.0`. Confirm current support before the live pilot and update the client/contract tests together when migrating; it does not silently use deprecated UGC or unversioned endpoints. [API versioning](https://learn.microsoft.com/en-us/linkedin/marketing/versioning).

## Server configuration and rollout

| Setting | Required meaning |
| --- | --- |
| `CONNECTION_MODE=live`, `APP_ORIGIN` | Explicit real provider mode and registered HTTPS callback origin |
| `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | Owner app credentials in the server secret store |
| `LINKEDIN_SCOPES` | Explicit approved scope array for member, organization or both |
| `LINKEDIN_MDP_REFRESH_ENABLED` | Actual programmatic refresh approval; default false |
| `SOCIAL_MEDIA_DIRECTORY`, `SOCIAL_MEDIA_PUBLIC_ORIGIN`, `SOCIAL_MEDIA_SIGNING_KEY` | Persistent private inspected media and trusted signed downloads |
| `SOCIAL_PUBLISHING_ENABLED`, `SOCIAL_APPROVED_PROVIDERS` | Separate global switch and approved destination kinds |

Keep publication disabled for connection review. An authorized pilot may allow `LINKEDIN:LINKEDIN_MEMBER` and/or `LINKEDIN:LINKEDIN_ORGANIZATION`; this does not establish provider approval. The worker still requires the exact owned selected destination and an immutable customer-reviewed revision. Follow [shared worker operations](social-delivery.md) for database migrations, keys, storage and worker startup.

The first path supports non-empty text (up to the implementation's 3,000-character limit), one inspected PNG/JPEG image or one inspected MP4 video. Visibility is explicit: Public or Connections for a member; Public for an organization. Trusted media is uploaded to the provider's signed upload plan; video parts, ETags, finalization markers and post receipts stay in encrypted progress. The application currently caps these uploads at 64 MiB; it does not claim to support all provider maxima or every rich-post format. [Images API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api) and [Videos API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api).

## Confirmation, recovery and cleanup

A create response with `x-restli-id` is a saved receipt. Success additionally requires reading that exact author's post and observing its expected visibility/media and published lifecycle. Pending processing remains uncertain; an ambiguous create does not authorize another create. Known failed post/media processing retains its receipt as a terminal failure. Permission or organization-role loss invalidates affected destination selection; it cannot redirect a delivery to another member or Page.

There is no native scheduled post in this path. Cancel/edit/disconnect stops unsent local work; an accepted request may still complete and must be reconciled. Disable the publishing switch or remove the specific kind from the allowlist to stop new submissions. Preserve encrypted progress and required keys while investigating. The SDK can delete a known post after current author/deletion checks and confirm its absence; the application does not automatically treat local deletion, disconnect or a failed job as provider cleanup. The pilot owner must record actual external removal.

## Mockoon evidence

`npm run mock:linkedin` starts the actual loopback HTTP fixture. Configure `CONNECTION_MODE=mock`, `LINKEDIN_MOCKOON_URL` and an explicit synthetic scope whitelist. Browser consent uses a fixture-only code and the real application callback, discovery and fresh selection; it does not replace provider JSON in the browser. Backend suites exercise member/organization text/image/video, uploads, lost responses, known failed processing, ownership/role checks and real SDK refresh coordination. The browser journey saves distinct member/organization drafts with explicit visibility and publication disabled. Execution results belong in release evidence; source alone is not a passing result. Synthetic identities and permissions are not proof of real Community Management approval, restricted read access, pilot publication or cleanup.

Primary provider contracts rechecked on 13 October 2026. Recheck owner console approvals and current API access before enabling the real pilot.
