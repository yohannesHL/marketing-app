import assert from "node:assert/strict";
import { test } from "node:test";
import { oauthBrowserFailure } from "../../apps/web/src/server/connections/oauthBrowserResponse";

test("browser OAuth failures retain safe customer guidance without provider contents", () => {
  const error = Object.assign(new Error("secret-token?code=private&state=private"), { code: "CONSENT_DENIED" });
  const response = oauthBrowserFailure("https://app.test", "google", error);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("Location"), "https://app.test/connections?provider=google&result=failed&error=CONSENT_DENIED");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("untrusted OAuth error names cannot enter redirect URLs", () => {
  const response = oauthBrowserFailure("https://app.test", "meta", Object.assign(new Error("private"), {
    code: "secret&state=private#token",
  }));
  assert.equal(response.headers.get("Location"), "https://app.test/connections?provider=meta&result=failed&error=PROVIDER_AUTHORIZATION_FAILED");
});
