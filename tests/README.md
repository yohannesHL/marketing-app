# Playwright test framework

This repository uses Playwright for browser-level validation of the Next.js app in `apps/web`.

## Setup

1. Copy `.env.example` to `.env`.
2. Install dependencies from the repo root with `npm install`.
3. Install Playwright browsers with `npx playwright install`.
4. Start writing specs in `tests/e2e/`.

## Running tests

- Local headless run: `npm run test:e2e`
- Headed run: `npm run test:e2e:headed`
- Debug mode: `npm run test:e2e:debug`
- Interactive UI mode: `npm run test:e2e:ui`
- Open the latest HTML report: `npm run test:e2e:report`

The Playwright config starts an isolated app through `npm run test:e2e:app`. It builds the app, creates a temporary database and encryption key, provisions test customers, and runs the custom Next server. It does not reuse an existing server or the developer database. Set `BASE_URL` to a free local port if the development server is already running.

## Customer security tests

Run `npm run test:security` for the database-backed session/connection tests. They build the legacy schema in a temporary SQLite database, apply the additive migration and exercise OAuth state, ownership, expiry/revocation, concurrent account operations, legacy encryption and key rotation.

Run `npm run test:e2e -- tests/e2e/customer-security.spec.ts tests/e2e/ads-proxy.spec.ts --project=chromium` for the running-app boundary and authenticated mock wizard launch. These tests use `signInTestCustomer` to obtain real application session cookies for isolated fixture users. Mock advertising requires explicit `ADS_MODE=mock`, set by the isolated runner.

Public planning pages remain accessible anonymously. Tests that submit advertising actions must sign in and include the configured Origin for API mutations. External provider exchange/discovery is later work and can use Mockoon fixtures when those integrations are added.

## Architecture overview

- `tests/e2e/` contains end-to-end specs.
- `tests/support/fixtures/` contains the merged Playwright test object and typed fixture contracts.
- `tests/support/fixtures/factories/` contains faker-backed builders for deterministic test data setup.
- `tests/support/helpers/` contains environment, network, and auth-oriented helpers.
- `tests/support/page-objects/` contains page-object wrappers for stable navigation and locators.

The fixture layer follows a composable `mergeTests` pattern so project fixtures can grow without making every spec wire its own helpers.

## Best practices

- Prefer `data-testid` selectors for durable UI assertions.
- Register network waits before navigation or clicks.
- Keep setup in fixtures, factories, or helpers instead of inline in each spec.
- Avoid fixed sleeps; wait on responses, locators, or other deterministic signals.
- Let fixture teardown own cleanup when tests begin creating persistent state.

## CI integration notes

- `playwright.config.ts` emits line, HTML, and JUnit reports for local and CI runs.
- In CI, retries are enabled and workers are capped for stability.
- The default base URL comes from `BASE_URL`, which should point to the deployed or ephemeral environment under test.

## Knowledge base references

- `_bmad/tea/testarch/knowledge/overview.md`
- `_bmad/tea/testarch/knowledge/fixtures-composition.md`
- `_bmad/tea/testarch/knowledge/data-factories.md`
- `_bmad/tea/testarch/knowledge/network-first.md`
- `_bmad/tea/testarch/knowledge/playwright-config.md`
- `_bmad/tea/testarch/knowledge/test-quality.md`

## Troubleshooting

- If Playwright cannot find browsers, run `npx playwright install`.
- If the app server never becomes ready, confirm `npm run test:e2e:app` works locally and that `BASE_URL` matches the server URL.
- If selectors become brittle, add or update explicit `data-testid` hooks near the user-facing surface being exercised.
