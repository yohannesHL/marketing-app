# Customer connection settings

Open `/sign-in` with a customer provisioned through the operator security command, then open `/connections`. Credentials remain on the server; the browser uses an expiring customer session cookie.

Paid advertising and Social publishing have separate grants. Connecting Google Ads or Meta Ads never enables YouTube, Facebook Page or Instagram publishing. Social destinations stay unavailable until their own integration and authorization are configured.

## Customer journey

1. Choose **Connect Google Ads** or **Connect Meta Ads**, then approve the requested provider consent.
2. Review discovered account names, currency, timezone and current access. An empty account list is a valid result; it does not select every account.
3. Choose an account explicitly. For Google, choose **Direct access** or a discovered manager access path first. Meta analyst-only accounts support read checks but cannot be selected for advertising management.
4. Use **Check read access** or **Check selected accounts** to verify current access without creating advertising resources. Selected-account results are reported individually when a provider has a partial failure.
5. Use **Refresh accounts** after an account or role changes. Reconnect if authorization expires or is revoked. **Disconnect** requires confirmation and invalidates pending operations.

## Operator modes

`CONNECTION_MODE` must be explicitly `mock` or `live`; otherwise connection actions are disabled. Mock mode requires real local Mockoon HTTP endpoints, `GOOGLE_ADS_MOCKOON_URL` and `META_ADS_MOCKOON_URL`. It uses synthetic credentials and labels connections as Mockoon. Live mode requires the credentials and registered callbacks in the [Google](google-ads-connection.md) and [Meta](meta-ads-connection.md) guides. Failed live requests never fall back to simulated success.

`ADS_MODE=mock` enables the existing advertising demo only when customer connections are not in live mode. Its wizard is labeled as a simulation and uses separate mock accounts. TikTok advertising in this demo does not represent a real supported customer integration. Campaign creation and asset publishing remain disabled in live mode. No campaign is created by connecting, selecting or checking an account.

`GET /api/connections/providers` supplies authenticated configuration readiness; it does not certify platform approval or campaign-write readiness. `POST /api/ads/readiness` accepts only explicit selected `destinationIds`, derives customer ownership from the session and checks the current provider account before returning a sanitized per-account result. Provider IDs and credentials are never accepted from the browser.

## Verification boundaries

Automated tests run with an isolated temporary database and real local Mockoon servers. They cover OAuth, selection, concurrent account contexts, customer isolation, mode separation and provider failures. Live pilot reads, platform approvals and validated paused writes remain operator prerequisites. See the [owner handoff](customer-ad-account-setup.md).
