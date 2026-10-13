/** Keep browser callbacks on the app and omit provider messages, codes and state. */
export function oauthBrowserFailure(origin: string, provider: "google" | "meta" | "youtube" | "meta-publishing" | "tiktok" | "linkedin" | "x", error: unknown) {
  const allowed = new Set(["CONSENT_DENIED", "INVALID_OAUTH_STATE", "MISSING_PERMISSION",
    "PROVIDER_REVOKED", "PROVIDER_IDENTITY_MISMATCH", "MISSING_REFRESH_TOKEN", "RECONNECT_REQUIRED"]);
  const code = error instanceof Error && "code" in error && typeof error.code === "string" && allowed.has(error.code)
    ? error.code : "PROVIDER_AUTHORIZATION_FAILED";
  return new Response(null, { status: 303, headers: {
    Location: `${origin}/connections?provider=${provider}&result=failed&error=${code}`,
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
  } });
}
