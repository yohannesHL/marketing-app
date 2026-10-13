# Customer connections browser evidence

Captured on 13 October 2026 using the isolated production test application, dedicated `connections-*` test customers, and actual Google Ads and Meta Mockoon HTTP fixtures. These images contain fixture identities and account IDs only. No credentials, OAuth codes, provider payloads, or customer data are included.

The `customer-connections.spec.ts` journey passes in Chromium, Firefox, and WebKit. It exercises keyboard sign-in, incorrect-password feedback, password-manager attributes, safe internal return destinations, loading and empty states, explicit Google direct/manager choices, saving a different verified manager, read checks, paginated discovery, reconnecting the same grant, Meta role restrictions, selected-account readiness, separate social publishing permissions, actual Mockoon consent denial, safe callback error messages, deselection, disconnect confirmation, and sign-out. Readiness sends only explicitly selected advertising destination IDs and reports live campaign writes disabled.

Each browser checks for horizontal overflow at 375×812, 812×375, and 1440×1000 CSS pixels with reduced motion enabled. The mobile account detail and desktop page were visually inspected for text wrapping and usable controls. Provider credentials remain server-side; the journey also checks that the public connection response and browser storage contain no fixture tokens.

Files use `<browser>-<view>.png` names:

- `mobile-connections`: complete 375px Google account discovery screen.
- `mobile-google-access-path`: selected advertiser and verified manager context.
- `desktop-connections`: complete desktop Google/Meta account screen and separate social section.
- `selected-account-readiness`: explicit Google/Meta read outcomes with live writes disabled.

Run with `npx playwright test tests/e2e/customer-connections.spec.ts`. The normal Playwright configuration creates an isolated application/database and starts local Mockoon providers. Each run uses at most two sign-in attempts per test customer. Interrupted runs are normalized through the same customer-owned public disconnect endpoint; legacy wizard fixture users are untouched.

These are mock-only connection and read-readiness results. Live OAuth configuration, owner approval, account access, write permissions, provider pilots, campaign creation, and social publishing remain unvalidated by this evidence.
