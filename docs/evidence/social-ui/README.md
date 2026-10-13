# Social UI fixture evidence

These screenshots show the separate Social publishing workflow on a temporary application database, with actual uploaded PNG bytes and a synthetic, explicitly labeled LinkedIn member connection. Provider publication is disabled and no enqueue request or external social publication occurred.

`tests/e2e/social-publishing.spec.ts` passed in Chromium, Firefox and WebKit after the mobile caption fix. The journey covers sign-in return, category navigation with saved content, trusted media upload and preview, destination variants, review/approval, edit invalidation, stale-save failure, timezone/DST choices and the disabled publishing gate. A layout assertion checks that the mobile caption remains readable.

The three browser prefixes identify desktop calendar, mobile review and mobile review-panel captures. Every capture was visually inspected. This is UI evidence only; enabled-provider delivery, live account authorization and actual platform approval require their own checks.
