import assert from "node:assert/strict";
import { test } from "node:test";
import { socialConfiguration } from "../../apps/web/src/server/social/configuration";

test("social publication requires an explicit mode, switch and destination allowlist", () => {
  assert.deepEqual(socialConfiguration({ CONNECTION_MODE: "mock" }), { mode: "mock", writesEnabled: false, approvedProviders: [] });
  assert.deepEqual(socialConfiguration({ CONNECTION_MODE: "live", SOCIAL_PUBLISHING_ENABLED: "true", SOCIAL_APPROVED_PROVIDERS: '["GOOGLE:YOUTUBE_CHANNEL"]' }),
    { mode: "live", writesEnabled: true, approvedProviders: ["GOOGLE:YOUTUBE_CHANNEL"] });
  for (const environment of [ {}, { CONNECTION_MODE: "disabled" }, { CONNECTION_MODE: "mock", SOCIAL_PUBLISHING_ENABLED: "1" },
    { CONNECTION_MODE: "mock", SOCIAL_APPROVED_PROVIDERS: '"all"' }, { CONNECTION_MODE: "mock", SOCIAL_APPROVED_PROVIDERS: '["GOOGLE:AD_ACCOUNT"]' },
    { CONNECTION_MODE: "live", SOCIAL_APPROVED_PROVIDERS: '["META:FACEBOOK_PAGE","META:FACEBOOK_PAGE"]' } ])
    assert.throws(() => socialConfiguration(environment), { code: "PROVIDER_DISABLED" });
});
