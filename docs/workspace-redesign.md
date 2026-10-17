# Marketing workspace

The public `/` page explains the product. Signed-in customers enter `/dashboard`, with campaign activity, selected channels, recent content, and quick actions. The collapsible desktop sidebar and mobile bottom navigation share the same routes.

| Area | Route | Available behavior |
| --- | --- | --- |
| Campaign library | `/campaigns` | Search and filter owned campaigns; list and social publishing calendar |
| Campaign builder | `/campaigns/create` | Social, paid ads, email, and blog plans; URL and brief; audience; channels before planning and creatives; saved drafts |
| Campaign detail | `/campaigns/:id` | Brief, creative drafts, execution readiness, archive/restore, linked social posts and exact review/delivery controls |
| Audience segments | `/campaigns/audiences` | Audiences saved in campaign definitions; CRM imports and lead scoring are not enabled |
| Content Studio | `/studio` | Saved copy, social posts, private media upload and reuse |
| Brand kit | `/studio/brand` | Durable identity, voice, audience, colors, and content rules |
| Social marketing | `/social` | Existing manual composer, calendar, revision approval, scheduling, and delivery recovery |
| Integrations | `/connections` | Separate paid and social authorizations with existing account selection and readiness checks |

Copilot, Workflows, Affiliate marketing, Analytics, and AI mind-map are navigation placeholders marked as forthcoming.

## Campaign flow

Choose type → enter website and campaign brief → goal and audience → channels → budget or publishing plan → platform-specific creatives → review. Continue and Save draft persist customer-owned records. Reloading a saved editor restores its step. Conflicting edits from another window are rejected instead of silently overwritten.

Social campaign copy can seed a manual post. Add actual media, destinations, and provider-specific settings, then approve the exact saved revision. Scheduling starts the existing publishing worker. Campaign cadence is a planning field; it does not generate or schedule unreviewed content automatically. Archiving a campaign does not cancel its scheduled deliveries; use the explicit delivery cancellation controls.

Paid campaigns use Google/Meta account-readiness checks. They do not create live ads. Email and blog save drafts without sending or publishing. Brief enhancement and generated draft previews now support real Codex generation through llm-gw with `WORKSPACE_AI_MODE=llm-gw` (and optional direct OpenAI); users explicitly apply or reject suggestions. See [campaign AI setup](campaign-ai-setup.md) for credentials, limits, and the independent mock mode. Website URLs are stored as brief context, not automatically crawled.

## Storage and setup

Apply `apps/web/prisma/migrations/20261014000000_workspace_campaigns/migration.sql` through the existing migration procedure before starting this version, and regenerate the Prisma client from the updated schema. The new `WorkspaceCampaign` and `BrandKit` records are owner-scoped; every API uses the existing customer session and mutation-origin checks. Existing connections, private media, and post revisions are reused.

The visual redesign itself needs no external credentials. Real AI assistance additionally needs the server API key described in [campaign AI setup](campaign-ai-setup.md). For real providers, follow [customer account setup](customer-ad-account-setup.md), [social publishing setup](social-publishing-setup.md), and [paid readiness](paid-advertising-readiness.md). Do not use the mock preview as evidence of live provider approval.

The local review preview runs at `http://127.0.0.1:3157`, with a disposable SQLite database, loopback Mockoon providers, and a real background publishing worker. Its synthetic sample content and credentials are separate from customer data. The previous preview on port 3156 remains separate. The current preview is a temporary process, not a deployed environment.

Validation and implementation boundaries are recorded in [the progress log](../proj/workspace-redesign/PROGRESS.md).
