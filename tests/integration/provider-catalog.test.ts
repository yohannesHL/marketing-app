import { test } from "node:test";
import assert from "node:assert/strict";
import { providerCatalog } from "../../apps/web/src/server/connections/providerCatalog";

test("catalog fails closed without explicit mode and never claims write or social approval", () => {
  let calls = 0;
  const result = providerCatalog({}, { GOOGLE: () => calls++, META: () => calls++ });
  assert.equal(result.mode, "disabled");
  assert.equal(calls, 0);
  assert.ok(result.paid.every((entry) => !entry.enabled && !entry.liveWritesEnabled));
  assert.equal(result.social.length, 6);
  assert.ok(result.social.every((entry) => !entry.enabled));
});

test("catalog isolates partial provider configuration and strips configuration error secrets", () => {
  const result = providerCatalog({ CONNECTION_MODE: "live" }, {
    GOOGLE: () => { throw new Error("secret=private-oauth-token"); }, META: () => ({}),
  });
  assert.equal(result.mode, "live");
  assert.equal(result.paid[0].enabled, false);
  assert.equal(result.paid[1].enabled, true);
  assert.ok(result.paid.every((entry) => !entry.liveWritesEnabled));
  assert.equal(JSON.stringify(result).includes("private-oauth-token"), false);
});


test("social configuration enables only installed connection flows without claiming publication approval", () => {
  const result = providerCatalog({ CONNECTION_MODE: "mock" }, { GOOGLE: () => ({}), META: () => ({}) }, {
    YOUTUBE: () => ({}), FACEBOOK: () => { throw new Error("secret-provider-configuration"); },
  });
  assert.equal(result.social.find((p) => p.provider === "YOUTUBE")?.enabled, true);
  assert.ok(result.social.filter((p) => p.provider !== "YOUTUBE").every((p) => !p.enabled));
  assert.ok(result.paid.every((p) => !p.liveWritesEnabled));
  assert.doesNotMatch(JSON.stringify(result), /secret-provider-configuration/);
});
