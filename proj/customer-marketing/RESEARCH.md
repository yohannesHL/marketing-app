# Customer marketing research

The existing app uses Next.js, a libSQL-backed Prisma database and per-platform adapters. Shared server sessions and encrypted grants provide the boundary for both marketing categories. Provider HTTP clients must verify subjects and granted permissions before persisting credentials, enumerate only accessible destinations, and recheck selected account access immediately before work.

External APIs are mocked using the MIT-licensed [Mockoon CLI](https://mockoon.com/cli/), with versioned environment files runnable locally and in CI. Mockoon operates independently of the application so production adapters exercise the HTTP boundary. Test configuration must be explicit and must never silently fall back from live to mock.

Current Google and Meta official contracts are being researched separately and will be captured with their provider implementations. Provider approvals and pricing are independent of mock testing and remain visible in owner setup documentation.
