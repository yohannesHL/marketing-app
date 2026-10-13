# TikTok Direct Post integration

## Connection and creator review

TikTok publishing uses its own `TIKTOK` / `SOCIAL` authorization; paid advertising consent cannot authorize it. Configure Login Kit Web and Content Posting API Direct Post for the business-owned app, register the exact deployed `APP_ORIGIN` plus `/api/connections/tiktok/callback`, and request `user.info.basic,video.publish`. `video.upload` inbox delivery is a different workflow. The confidential Web exchange uses private session-bound state and the registered redirect; this implementation does not claim undocumented Web PKCE support. [Login Kit Web](https://developers.tiktok.com/docs/en/login-kit-web), [Direct Post](https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post).

The server verifies the returning `open_id` using TikTok's user endpoint. Reconnection must use the original subject. Discovery, checking and selection fetch creator information server-side and store a normalized version bound to the owned authorization and consent generation. The browser cannot supply credentials, a creator snapshot or a replacement provider identity.

The composer automatically checks each TikTok destination on composer load or its first addition. Cached connection metadata cannot enable posting consent while the check is pending or after it fails. Manual refresh retries a failed check without discarding unsaved content. The composer displays the verified creator nickname/username, current duration limit and settings timestamp. Privacy has no default. Available privacy choices come from the current creator response; the application restricts them further when unaudited. Creator-disabled comments, Duet and Stitch remain unavailable. Other interaction choices require an explicit decision. Changing creator settings requires a fresh review. The worker rechecks the actual creator response before submission, so a saved choice cannot bypass changed eligibility. [Creator information](https://developers.tiktok.com/docs/en/content-posting-api-reference-query-creator-info).

The customer chooses commercial disclosure, applicable own-brand/third-party labels, music-policy consent and AI disclosure. Third-party branded content cannot use private visibility. The exact selected video is previewed before the final posting-consent checkbox. Changes to caption, media, destinations or posting options clear that consent. Refreshing creator settings clears obsolete choices while preserving unsaved content; scheduling separately requires approval of the saved revision. [Required sharing controls](https://developers.tiktok.com/docs/en/content-sharing-guidelines).

## Owner setup and approval gates

Provide the app owner, approved products/scopes, exact HTTPS callback, policy/terms and deletion instructions, pilot creator and the review recording of the actual customer journey. Audit **this intended scheduled publishing flow** before public rollout. An app restricted to internal team uploads does not establish acceptable intended use. No real app audit, public scheduling approval or customer publishing pilot has been completed here.

Until approval is recorded, keep `TIKTOK_APP_AUDITED=false`. Unaudited testing requires private creator accounts and `SELF_ONLY`; the documented cap is five posting users per 24 hours. Active-creator and creator posting caps also apply after audit. A setting flag cannot establish approval. Supply the real owner console evidence and obtain explicit pilot approval before enabling writes. [Audit and intended-use gates](https://developers.tiktok.com/docs/en/content-sharing-guidelines).

Install these only on the server:

| Setting | Purpose |
| --- | --- |
| `APP_ORIGIN` | Exact application origin and registered callback base |
| `CONNECTION_MODE=live` | Real provider endpoints and credentials; no Mockoon fallback |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | Business-owned confidential Web client; secret-store values |
| `TIKTOK_VERIFIED_MEDIA_PREFIX` | Exact owned HTTPS media prefix verified in TikTok's Manage URL properties |
| `TIKTOK_APP_AUDITED` | `false` until documented approval of this app and flow; `true` only after that gate |
| `SOCIAL_MEDIA_DIRECTORY`, `SOCIAL_MEDIA_PUBLIC_ORIGIN`, `SOCIAL_MEDIA_SIGNING_KEY` | Persistent private storage and provider-reachable signed media delivery |
| `SOCIAL_PUBLISHING_ENABLED`, `SOCIAL_APPROVED_PROVIDERS` | Separate write switch and explicit destination-type allowlist |

Keep `SOCIAL_PUBLISHING_ENABLED=false` and `SOCIAL_APPROVED_PROVIDERS=[]` through connection-only review. Once a specific pilot is authorized and its external gates are satisfied, the TikTok destination-type entry is `TIKTOK:TIKTOK_PROFILE`; selected destination IDs and reviewed content still govern each delivery. [Shared worker and media operations](social-delivery.md) cover migrations, storage, keys and worker startup. Do not place tokens or signed URLs in evidence.

## Tokens, media and durable delivery

TikTok documents initial access of 24 hours and initial refresh validity of 365 days. The app stores the actual `expires_in` and `refresh_expires_in`, verifies subject and scopes on renewal, and retains the actual replacement refresh token. Browser checks and offline workers share a durable renewal lease, so they cannot independently consume the same rotating token. A lost or unverified refresh response requires reconnection; retrying the old token would be unsafe. This is separate from the delivery publication lease. [Token management](https://developers.tiktok.com/docs/en/oauth-user-access-token-management).

This release supports one inspected video per TikTok variant. Media is decoded server-side; browser duration and codec claims do not authorize publishing. The first path accepts supported MP4/WebM/QuickTime media within the actual creator duration and the application's ten-minute cap, supported dimensions, codecs, frame rate and configured storage limits. Unsupported content fails before provider submission.

Scheduled server-held media uses `PULL_FROM_URL`. The owned HTTPS prefix must be verified with TikTok, redirects are rejected, and the signed URL must remain reachable for the full download window. The implementation reserves at least one hour of validity before dispatch and checks the media response and current authorization before initialization. TikTok's documented pull timeout is one hour after initiation. File-upload chunking is not claimed for this server-storage path. [Media transfer](https://developers.tiktok.com/docs/en/content-posting-api-media-transfer-guide).

The adapter performs fresh creator and media checks, then exactly one final submission boundary. Its `publish_id` and recovery evidence are saved in encrypted progress. A pending download, timeout, lost initialization response or later status failure stays uncertain; none permits blind creation of another post. Provider-confirmed failures permit only the implemented bounded recovery categories, with prior failed receipts retained. Restart, cancellation, editing or disconnection cannot silently replace a sent publication with a new one.

Publication requires actual Direct Post `PUBLISH_COMPLETE` status. Public post IDs may be delayed until moderation. A private completion may retain its opaque `publish_id` as the receipt, including valid provider characters such as `~`; this is not a public video ID. The app does not fabricate a TikTok URL. An inbox notification is not proof that this Direct Post flow published content. [Status contract](https://developers.tiktok.com/docs/en/content-posting-api-reference-get-video-status).

## Cancellation, rollback and pilot evidence

Disable `SOCIAL_PUBLISHING_ENABLED` to stop new worker submissions; remove TikTok from the allowlist when its integration should remain unavailable. Preserve the database, retained decryption keys and progress during investigation. Changing the switch does not undo a request already accepted by TikTok. Local cancellation fences unsent work; an in-flight request remains subject to reconciliation.

The SDK can best-effort cancel an ongoing URL download and read its status afterward. Cancellation can fail near completion or once processing has begun. This is not a published-video deletion API. After an approved real pilot, the owner checks and removes test content in TikTok and records actual cleanup; local success, disconnection or deletion of application records is not external-content cleanup. [Cancellation limitations](https://developers.tiktok.com/docs/en/content-posting-api-media-transfer-guide).

Keep the [readiness tracker](social-publishing-readiness.md) open for approval evidence, the review recording, verified pilot identities, exact app revision/media/privacy/time, actual provider receipt/final status, and cleanup. No automatic live pilot or public activation is part of this change.

## Mockoon and browser evidence

Run the local fixture with `CONNECTION_MODE=mock` and `TIKTOK_MOCKOON_URL` pointing to the explicit loopback Mockoon server. Its synthetic identities, permission/settings responses and token rotations are contract evidence only. The fixture's `fixture_consent=private` authorization scenario redirects through its real HTTP callback using the existing private-account grant; it does not establish a real private TikTok account or audit approval.

The new browser journey signs in as an isolated test customer, connects/selects the actual fixture creator, creates a real three-second portrait MP4 with FFmpeg in a temporary directory, and uploads it through the application's decode/storage path. It checks unselected privacy, creator-disabled interactions, explicit disclosures/policy consent, caption-edit acknowledgment reset and dirty-caption preservation through actual creator refresh, then saves the real draft. Publication stays disabled and no job is enqueued. Chromium/Firefox/WebKit executions and screenshots must be recorded by the release checks; test source alone is not a passing result. No binary media is committed. Backend suites separately cover HTTP SDK/adapter behavior, renewal, ownership and recovery; none substitutes for owner approval or a live publishing pilot.

Primary provider contracts rechecked on 13 October 2026. Recheck the current console and provider requirements when preparing the real review/pilot.
