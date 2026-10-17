# YouTube Shorts connection and delivery

## What is implemented

YouTube uses a separate Google `SOCIAL` authorization. Google Ads access cannot authorize uploads. OAuth requests `openid` and `https://www.googleapis.com/auth/youtube.force-ssl`, PKCE, and offline access. The verified Google subject and the channels returned by `channels.list(mine=true)` establish identity; neither an email nor an advertising account ID identifies the channel.

In Connections → Social publishing → YouTube Shorts, connect, choose the intended channel or Brand Account during Google consent, and select the discovered destination. Selection performs fresh discovery. Ordinary user upload consent must resolve to exactly one channel; ambiguous multiple-channel consent stays unavailable and needs reconnection. An ordinary upload token cannot be retargeted by setting `snippet.channelId`.

The social workspace accepts a verified square or portrait MP4 up to 180 seconds, an explicit video title, description, category, privacy choice, made-for-kids choice and synthetic-media disclosure. The app schedules delivery in its own durable queue. It does not create a YouTube native `publishAt` schedule. Cancel/reschedule therefore changes unsent app jobs. A request already accepted by YouTube can complete after cancellation; its saved receipt is reconciled honestly.

Resumable session URLs and upload progress are encrypted on the server. The session is saved before sending chunks, and the video ID before processing checks. A restart probes the same session or known video. An unknown initiation outcome stays uncertain instead of starting another upload. An accepted upload or a successful HTTP response does not establish ready delivery: channel identity, processing state and the requested privacy must match. Private videos can complete without a public link. Verified rejected processing becomes a terminal failed delivery with its receipt retained; retry cannot create another video.

Shorts eligibility is a content constraint, not a promise of classification, feed placement or reach. YouTube determines classification. There is no separate Shorts publishing endpoint.

## What you need to set up

Follow [the owner setup guide](social-publishing-setup.md) and record status in [the readiness checklist](social-publishing-readiness.md).

1. Create or choose the Google Cloud project used for this app's YouTube integration, enable YouTube Data API v3, and create a Web application OAuth client. Configure the consent screen, authorized domains, privacy policy and terms. Register the exact deployed `APP_ORIGIN` plus `/api/connections/youtube/callback` as an authorized redirect URI.
2. Install `YOUTUBE_CLIENT_ID` and `YOUTUBE_CLIENT_SECRET` in the server secret store. Install the shared encryption keyring, persistent database/private media volume and media signing secret. Do not put tokens or secrets in browser storage, issue comments or client configuration.
3. Establish the supported customer channel/Brand Account, its ownership and OAuth consent. Check the actual consent/app verification state, channel upload restrictions and project quota in the Google console. App configuration and Mockoon evidence do not establish production approval or available quota.
4. Install FFmpeg/ffprobe and configure the private media store. Use `CONNECTION_MODE=live` explicitly for live connections. YouTube settings are separate from `GOOGLE_CLIENT_ID` and the Ads setup.
5. Keep publication disabled until the destination and reviewed content have been approved for a pilot. To run the worker, enable `SOCIAL_PUBLISHING_ENABLED=true` and explicitly allow `GOOGLE:YOUTUBE_CHANNEL` in `SOCIAL_APPROVED_PROVIDERS`. The customer must independently review the current content revision and its destinations before scheduling. The worker rechecks current ownership, permissions, grant generation, media and cancellation at every provider request.
6. Run a bounded pilot with a channel you control, a small verified video and explicit privacy/disclosure choices. Record the Google project, channel, consent and approval status, app revision, receipt, actual processing/privacy outcome and cleanup. Do not record credential values. Use the YouTube interface or a separately approved cleanup operation to remove a test video; local cancellation does not delete an already uploaded video.

Expired access is renewed with the encrypted offline credential and a verified same-subject response. Required scopes and actual returned expiry are checked before storing the new credentials. The scheduled worker does not need the customer's browser session. Revocation/reconsent/deselection stop unsent jobs; an in-flight or known accepted outcome remains available for safe reconciliation.

## Local Mockoon checks

`npm run mock:youtube` serves the YouTube fixture at `http://127.0.0.1:3912`; set `YOUTUBE_MOCKOON_URL` accordingly with `CONNECTION_MODE=mock`. Live and mock grants cannot be mixed. The fixture's synthetic OAuth identity, channel IDs, video bytes and receipt IDs are test data.

`npm run test:security` runs the connection, provider and durable-worker suites. The browser runner creates an isolated database and real local Mockoon servers, exercises consent/discovery/selection/deselection/disconnection, and leaves publishing disabled for that UI journey. The upload adapter tests exercise actual HTTP requests against Mockoon, including encrypted durable progress and restart reconciliation. Media-store tests separately inspect actual decoded files. The scheduled-renewal test isolates the queue contract using a synthetic adapter and actual OAuth renewal HTTP; it does not claim that its eight-byte database fixture is a decoded video.

No real Google credentials, project quota check, customer consent, platform approval or live publication has been performed by these checks. Those owner gates remain in the readiness checklist and do not block engineering closure of issue #12 under the owner’s 17 October acceptance boundary.

## API and source references

Customer routes: `POST /api/connections/youtube/start`; `GET /api/connections/youtube/callback`; and `POST /api/connections/youtube/{authorizationId}/{refresh,check,select}`. Public requests accept local connection/destination IDs only; provider tokens, channel overrides and credentials are rejected.

- [Google OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server)
- [YouTube channels.list](https://developers.google.com/youtube/v3/docs/channels/list)
- [YouTube videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert)
- [YouTube resumable uploads](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol)
- [YouTube videos.list processing and status](https://developers.google.com/youtube/v3/docs/videos/list)
- [YouTube three-minute Shorts eligibility](https://support.google.com/youtube/answer/15424877?hl=en)
