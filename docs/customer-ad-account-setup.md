# Google and Meta customer ad account setup

This guide covers the business setup Yohannes needs to complete and the engineering work required before customers can connect Google Ads and Meta ad accounts to LaunchPad. Customers keep ownership and billing of their ad accounts. Connecting an account must not start advertising or spend money.

Status: customer security, Google/Meta connection endpoints, connection settings, selected-account reads and Mockoon verification are implemented. Live advertising writes are outside this connection release. The 17 October 2026 issue audit accepts implementation and fixture evidence without requiring API keys or live verification; see [completion audit](implementation-completion-audit.md). Platform guidance checked on 13 October 2026; verify the current developer console requirements when submitting applications.

## What you can set up now

### Shared business details

- [ ] Choose the production app domain and a separate staging domain, both with HTTPS.
- [ ] Provide the business name, website, support email, and privacy contact.
- [ ] Prepare business verification documents for submission directly to the platform if requested.
- [ ] Approve the privacy policy, terms, data deletion process, and retention policy. Review the implemented `/privacy`, `/terms` and `/data-deletion` pages. They remain explicitly marked as policy previews until operator review; they describe connection-scoped removal separately from full account requests and provider-side post cleanup.
- [ ] Choose one Google Ads account and one Meta ad account for the pilot. Use an account you are authorized to manage; keep billing on the advertiser's account.
- [ ] Ensure the business retains administrative ownership of its developer projects and applications.

Share domains, project/app IDs, pilot account IDs, and approval status with the implementer. Put client secrets and encryption keys in the hosting provider's secret store or a secure credential manager; do not paste them into GitHub issues, source control, screenshots, or chat.

### Google Ads

1. Create or select a business-owned project in [Google Cloud Console](https://console.cloud.google.com/), then enable the Google Ads API.
2. Configure Google Auth Platform branding, audience, support contact, website, privacy policy, and authorized domains for an external customer-facing app. Add designated test users while testing.
3. Create an OAuth client of type Web application. Register the exact staging and production redirect URLs agreed with engineering. Use customer user authorization; customers should not have to create service accounts.
4. Configure the Google Ads scope `https://www.googleapis.com/auth/adwords`. Complete the OAuth publishing/verification requirements shown for the app. OAuth approval and Ads API production access are separate checks.
5. In the Google Ads API overview in Cloud Console, apply for production access suitable for the pilot, then upgrade as needed. Test-only access cannot manage production ad accounts.
6. Supply the Cloud project ID, OAuth client ID, secret-store reference for its secret, access status, and pilot customer ID. Supply a manager account ID only when using that manager hierarchy.
7. Once the staging app works, complete any review that requires a working demonstration.

Google moved Ads API access management to Cloud projects and retired developer tokens on 9 September 2026. Do not follow old instructions requiring a new developer token from the Ads manager API Center. Google Ads API usage itself is free; hosting and advertising spend remain separate.

Sources: [Cloud project setup](https://developers.google.com/google-ads/api/docs/oauth/cloud-project), [access levels](https://developers.google.com/google-ads/api/docs/api-policy/access-levels), [developer token migration](https://developers.google.com/google-ads/api/docs/api-policy/developer-token), [OAuth authorization](https://developers.google.com/google-ads/api/docs/oauth/overview).

### Meta Facebook and Instagram advertising

1. Create or select the business portfolio that will own the integration and create the application in [Meta for Developers](https://developers.facebook.com/apps/).
2. Configure Marketing API access and the supported business login flow for external customers. Register app domains and the exact OAuth redirect URLs agreed with engineering.
3. Enter the privacy policy, terms, contact details, and data deletion/deauthorization details requested in the developer console. Engineering supplies the working endpoints and pages.
4. Complete the business verification steps the console requires. Keep verification documents with Meta rather than in the repository.
5. Request the permissions needed by the implemented flow: `ads_management` for management and `ads_read` where required for reporting. Managing other businesses' accounts requires the appropriate reviewed access. Current `ads_management` depends on `pages_read_engagement` and `pages_show_list`; include those reviewed dependencies in the Business Login USER-token configuration. External customer login additionally needs Advanced Access to `public_profile`. Request `business_management` and publishing permissions only when their separate implemented flows need them.
6. Add designated app testers and select a pilot ad account. For creative tests, also provide the relevant Facebook Page and Instagram identity with the necessary roles. An ad account connection alone does not grant access to every Page or Instagram account.
7. When engineering provides a working staging flow, submit App Review with precise test instructions, a reviewer login where required, and a recording demonstrating each requested permission. Enable customer production access only after the required approvals are granted.
8. Supply the app ID, business portfolio ID, secret-store reference for the app secret, any login configuration ID required by the selected flow, pilot asset IDs, and approval status.

Source: [Meta's official Marketing API collection and permissions guidance](https://www.postman.com/meta/facebook-marketing-api/documentation/0zr4mes/facebook-marketing-api-mapi). Review requirements and product labels must be checked in the app's current dashboard; permission approval is separate from a customer's own role on an ad account.

## What engineering must provide

- Authenticated customer sessions and account ownership checks for every connection and advertising action.
- Connect, account selection, reconnect, and disconnect flows for Google and Meta.
- Encrypted credential storage, expiry and permission tracking, token renewal where supported, and clear reauthorization prompts when access expires or is revoked.
- Callback protection, including short-lived single-use authorization state bound to the signed-in customer; use PKCE where supported by the selected flow.
- Account discovery, permission validation, currency/timezone metadata, and safe treatment of manager accounts and advertising identities.
- A connection settings screen with account names, status, last successful check, and actionable errors.
- Updated provider adapters and customer-scoped execution. Requests must use only explicitly selected accounts, with no fallback to every account or to mock success.
- A separate explicit test/demo mode. Live mode must never silently use fake accounts.
- Read-only campaign/report checks and a narrowly scoped paused-campaign test. Full creative publishing, automated optimization, conversion tracking, and other platforms are separate work.
- A reviewer demonstration, pilot instructions, documented rollback, and sanitized validation evidence.

## Configuration contract

Google and Meta names and callbacks below are implemented. Keep this table synchronized with the example environment file. Replace `APP_ORIGIN` with each agreed HTTPS app origin; it is not a literal hostname.

| Setting | Value or responsibility |
| --- | --- |
| `APP_ORIGIN` | Engineering configures the selected app origin for each environment |
| `GOOGLE_CLIENT_ID` | You create the web OAuth client; engineering installs its ID |
| `GOOGLE_CLIENT_SECRET` | You place the client secret in the agreed secret store |
| Google callback (derived) | `APP_ORIGIN/api/connections/google/callback`; register this exact URL |
| `META_APP_ID` | You create the Meta application; engineering installs its ID |
| `META_APP_SECRET` | You place the app secret in the agreed secret store |
| `META_LOGIN_CONFIG_ID` | Required USER-token Business Login configuration for this Ads flow |
| Meta callback (derived) | `APP_ORIGIN/api/connections/meta/callback` |
| `CONNECTION_TOKEN_KEYS` | Implemented foundation: server keyring JSON mapping IDs to base64 32-byte keys |
| `CONNECTION_ACTIVE_KEY_ID` | Implemented foundation: ID of the key used for new credential encryption |
| `CONNECTION_MODE` | `mock` or `live` for provider OAuth/discovery; no fallback |
| `GOOGLE_ADS_MOCKOON_URL` | Loopback Mockoon origin, used only in explicit mock mode |
| `ADS_MODE` | Existing campaign execution: mock; live campaign/asset writes are outside this connection release |

Register `APP_ORIGIN/api/connections/meta/data-deletion` and `APP_ORIGIN/api/connections/meta/deauthorize` as Meta callbacks. Separate test and production credentials wherever supported. No secret setting may use a browser-exposed `NEXT_PUBLIC_` variable.

The shared session/credential foundation is documented in [Customer sessions and secure connections](customer-connection-foundation.md). That guide supplies the implemented configuration and migration commands; [Google connection setup](google-ads-connection.md) documents implemented endpoints, manager selection and local Mockoon commands. [Meta connection setup](meta-ads-connection.md) documents Business Login, signed callbacks and actual deletion receipts.

## What each pilot customer needs

- An existing ad account and a user with sufficient permissions for the requested action.
- An eligible account and valid billing for eventual delivery of ads; billing is not required just to consent or inspect an accessible account.
- Access to the Page/Instagram identity when publishing creative requires it.
- Consent through the platform's own login screen, then selection of the accounts to connect.

Customers do not provide passwords or developer app secrets. They can disconnect later. Local disconnection must stop jobs immediately; engineering must implement and explain any provider-level revocation that also affects other accounts under the same authorization.

## Pilot completion checklist

- [ ] Both platforms allow the selected pilot user and account; public customer access approvals are tracked separately.
- [ ] Customer can connect, select the intended account, and read real campaign data.
- [ ] Two customers and two accounts on the same platform stay isolated, including concurrent requests.
- [ ] Expiry, denied consent, lost permissions, and provider outages produce clear recovery steps.
- [ ] Disconnect removes usable local credentials and prevents subsequent scheduled or queued access.
- [ ] Optional paused-campaign verification is explicitly enabled for a designated account, remains paused, and records cleanup. Connection alone never creates or activates a campaign.
- [ ] Production readiness evidence includes actual provider calls; simulated tests are labeled as such.

## Handoff from you

The first items needed are the production/staging domains, business/support details, Google Cloud project and Meta app IDs, pilot account IDs, and confirmation that secrets are installed in the agreed secret store. Engineering can build against fixtures while approvals are pending. Real-account validation needs credentials and account access; public onboarding additionally needs the relevant platform approvals.

## Implementation tracking

- [Google and Meta implementation tracker](https://github.com/yohannesHL/marketing-app/issues/8)
- [Owner setup and documentation checklist](https://github.com/yohannesHL/marketing-app/issues/2)
- [Customer ownership and secure storage](https://github.com/yohannesHL/marketing-app/issues/3)
- [Google account connections](https://github.com/yohannesHL/marketing-app/issues/4)
- [Meta account connections](https://github.com/yohannesHL/marketing-app/issues/5)
- [Connection settings and account routing](https://github.com/yohannesHL/marketing-app/issues/6)
- [Pilot verification and rollout](https://github.com/yohannesHL/marketing-app/issues/7)

## Public policy pages

The public routes `/privacy`, `/terms` and `/data-deletion` require no sign-in and are linked from the landing page. Configure `SERVICE_OPERATOR_NAME`, `PRIVACY_CONTACT_EMAIL` and `SERVICE_RETENTION_NOTICE` with reviewed, non-secret operator information. Missing values are visibly identified, not replaced by invented company details or retention promises. The pages remain labelled policy previews; business/legal approval is an owner rollout task. Meta’s signed callbacks remain the API URLs above, not the human-readable deletion page.
