# LaunchPad

## Customer ad account connections

- [Google and Meta setup guide](docs/customer-ad-account-setup.md)
- [Implementation tracker](https://github.com/yohannesHL/marketing-app/issues/8)

## Social publishing

- [Social publishing scope and owner setup](docs/social-publishing-setup.md)
- [Social publishing implementation tracker](https://github.com/yohannesHL/marketing-app/issues/18)
- [UI distinction between paid advertising and social publishing](https://github.com/yohannesHL/marketing-app/issues/11)

## Customer security foundation

- [Sessions, encrypted credentials, migration, and operator setup](docs/customer-connection-foundation.md)
- [Google OAuth, manager discovery, and Mockoon setup](docs/google-ads-connection.md)
- [Meta Business Login, signed callbacks, and Mockoon setup](docs/meta-ads-connection.md)
- Security integration tests: `npm run test:security`

Customer account settings and environment behavior: [connection settings](docs/customer-connection-settings.md).

Controlled connection-only rollout, read-only pilot checks and rollback: [operator guide](docs/paid-ads-rollout.md).

Google/Meta implementation evidence and remaining public-release gates: [paid advertising readiness](docs/paid-advertising-readiness.md).

Social publishing owner setup, permissions, costs and review requirements: [social setup](docs/social-publishing-setup.md) and [social readiness tracker](docs/social-publishing-readiness.md).

Social review, scheduling, trusted media storage and worker operations: [delivery foundation](docs/social-delivery.md).
