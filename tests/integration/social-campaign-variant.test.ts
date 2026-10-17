import assert from "node:assert/strict";
import test from "node:test";
import { initialSocialVariant, socialFormats } from "../../apps/web/src/components/social/socialUi";

test("campaign handoff preserves supported creative formats for every publishing destination", () => {
  for (const kind of ["YOUTUBE_CHANNEL", "FACEBOOK_PAGE", "INSTAGRAM_PROFILE", "TIKTOK_PROFILE", "LINKEDIN_MEMBER", "LINKEDIN_ORGANIZATION", "X_PROFILE"]) {
    for (const format of socialFormats(kind)) {
      const variant = initialSocialVariant("selected-account", kind, {
        format, title: "Reviewed title", body: "Platform-specific caption",
        script: "Private production direction", mediaIds: ["unreviewed-media"],
        providerOptions: { explicitPostingConsent: true },
      });
      assert.deepEqual(variant, { destinationId: "selected-account", format,
        title: "Reviewed title", body: "Platform-specific caption", mediaIds: [], providerOptions: {} });
    }
  }
});

test("manual drafts retain shared-caption inheritance and invalid formats cannot bypass platform choices", () => {
  for (const kind of ["FACEBOOK_PAGE", "LINKEDIN_MEMBER", "LINKEDIN_ORGANIZATION", "X_PROFILE"]) {
    const variant = initialSocialVariant("destination", kind);
    assert.equal(variant.format, "TEXT");
    assert.equal(variant.body, undefined);
  }
  for (const kind of ["YOUTUBE_CHANNEL", "TIKTOK_PROFILE", "INSTAGRAM_PROFILE"]) {
    const variant = initialSocialVariant("destination", kind, { format: "TEXT", body: 123 });
    assert.equal(variant.format, "SHORT_VIDEO");
    assert.equal(variant.body, undefined);
  }
});
