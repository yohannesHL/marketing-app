# Facebook and Instagram publishing

## What the connection supports

Organic Meta publishing has its own `META` / `SOCIAL` authorization and Business Login configuration. Meta Ads consent does not authorize posts. The chosen flow uses Facebook Login for Business with USER tokens: the app verifies the Meta app, actual user subject, granted scopes and expiry, then discovers Facebook Pages and their linked Instagram professional accounts. Eligible assets have content creation/management tasks. Personal Facebook profiles and unlinked or ineligible Instagram accounts cannot be selected for publication.

Facebook Pages and Instagram profiles appear as separate destinations. A read-only asset stays visible and unavailable for selection. An Instagram profile without a display name is shown by its username. Selecting or checking an asset performs fresh provider verification of its current user, Page credential, asset linkage and permission. No client-supplied Page ID or token can replace that proof.

Supported formats are Facebook Page text/image posts and Reels, and Instagram image posts and Reels. Facebook Reel AI disclosure and Instagram Reel feed-sharing are explicit separate choices. Changing a Meta format clears incompatible choices. Verified image/video dimensions, duration, codec, frame rate and audio information are checked against the selected format. Instagram's image path requires JPEG; the media store validates actual decoded files rather than browser claims.

The app uses its own scheduler; it does not create native Meta schedules. Each destination has independent preparation, processing and delivery status. Upload/container receipts are saved before final submission and encrypted on the server. Publication requires provider readback, not just an accepted upload or container creation response. Pending processing, a later429 or an unknown final response retain their receipts and remain uncertain without repeating final publication. Verified processing errors are terminal and preserve the failed receipt. An Instagram container reporting PUBLISHED without a final media ID remains uncertain: the app cannot invent a post ID or repeat `media_publish`.

## Page credentials and lifecycle

Page access tokens are stored separately from public destination metadata, encrypted with owner, authorization, mode, consent generation and Page identity bound as authenticated data. Resolution requires the current selected owned SOCIAL destination, correct Page linkage, verified subject and generation, permissions and expiry. Parent encryption-key rotation does not masquerade as new consent. The maintenance command rewraps both USER credentials, Page credentials and encrypted delivery progress, using compare-and-swap so concurrent installs or deletion cannot lose newer data. Keep old keys available until rotation is complete.

Meta signed deauthorization affects both Ads and Social grants associated with the same verified app/user identity. It stops unsent jobs and retains honest uncertainty for requests already sent. The signed deletion flow removes owned authorizations/destinations and cascades private Page credentials. It does not claim deletion of content already published at Meta. Local cancellation likewise cannot undo an accepted post; external deletion/cleanup requires the documented owner action and actual provider confirmation.

Meta USER access is not renewed with an invented refresh token. Expired or revoked access needs reconnection. A future app job cannot bypass an expired grant or Page credential.

## What you need to set up

1. Follow the [owner setup guide](social-publishing-setup.md) and [readiness checklist](social-publishing-readiness.md). Configure a Meta app and an independent Facebook Login for Business USER-token configuration for organic publishing. Install `META_APP_ID`, `META_APP_SECRET`, and `META_PUBLISHING_CONFIG_ID` only in the server secret store. Ads uses its separate `META_LOGIN_CONFIG_ID`; both share the same app identity and signed lifecycle secret.
2. Register the exact deployed `APP_ORIGIN` plus `/api/connections/meta-publishing/callback`, and the app's signed deauthorization/deletion callbacks. Supply the required policy, terms, data deletion instructions and review demonstrations. Record actual business verification, permissions/Advanced Access and Live-mode approval rather than inferring approval from successful configuration.
3. Arrange Page content creation access and the linked Instagram professional accounts used for customer consent. The implementation verifies the minimum scopes `public_profile`, `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, and `instagram_content_publish`. Check the guide's conditional Business Manager access matrix for the assets and operations in your actual approval; include any required conditional permissions in the separate publishing Business Login configuration and obtain their actual approval. Additional scopes are not silently invented or granted by the app.
4. Install the persistent private media volume, encryption/signing keys and FFmpeg/ffprobe. Set a provider-reachable HTTPS media origin. Media URLs must remain available throughout the fetch/processing window; this integration requires at least 30 minutes. Instagram containers expire; the app checks age and current container status before final publication. It reads Instagram's actual publishing-limit usage/configuration instead of fabricating quota values. There is no fabricated Facebook quota endpoint.
5. Set `CONNECTION_MODE=live` explicitly for real connections. Keep publication disabled until your reviewed pilot destinations and content are approved. Enable the worker with `SOCIAL_PUBLISHING_ENABLED=true` and explicitly allow `META:FACEBOOK_PAGE` and/or `META:INSTAGRAM_PROFILE` in `SOCIAL_APPROVED_PROVIDERS`. Selection alone neither publishes nor grants production approval.
6. Run a small, explicitly approved pilot on assets you control. Record each format/destination, the selected identity/linkage, exact app revision, provider receipt, processing/final outcome and cleanup. Verify the actual posts at Facebook/Instagram and remove test content through the provider's UI or a separately approved cleanup operation. Do not put credential values in evidence.

## Mockoon evidence and limits

`npm run mock:meta-publishing` serves the real local HTTP fixture at `http://127.0.0.1:3913`. Set `META_PUBLISHING_MOCKOON_URL` and `CONNECTION_MODE=mock`. Its synthetic app 123 shares the fixture app secret with the Ads/signed lifecycle fixture; publishing uses a separate configuration 789. These identifiers establish only fixture behavior.

The provider, adapter, connection and Page-store suites cover each initial format; current Page/profile checks; cross-owner, mode and subject rejection; permission/linkage loss; quota recovery; expired containers and credentials; encrypted receipts; ambiguous final submission; processing outcomes; consent and rotation races; signed deauthorization/deletion; and deletion during key-rotation pagination. The browser journey uses an isolated database and actual Mockoon consent/discovery/selection, displays separate FB/IG controls, and saves a real Facebook text draft while publication remains disabled. Worker tests use trusted database media fixtures for the protocol; actual file decode/storage/signing has separate media-store coverage.

No live Meta credentials, platform approval, business verification, real consent or customer publication has been performed. Issue #13 and the readiness checklist retain those owner gates.

## Sources

- [Meta Facebook API documentation](https://www.postman.com/meta/facebook/documentation/r56bjfd/facebook-api)
- [Meta Instagram API documentation](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api)
- [Meta Facebook Business SDK Page operations](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/page.py)
- [Meta Facebook Business SDK Instagram operations](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/iguser.py)
- [Meta Facebook Business SDK Instagram media status](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/igmedia.py)
