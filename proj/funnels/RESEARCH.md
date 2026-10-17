# Configurable funnels research

Baseline: remote main `802050e`, 17 October 2026. Product requirements and complete earlier research are preserved in [epic #35](https://github.com/yohannesHL/marketing-app/issues/35). The canonical implementation decisions are in [the contract](../../docs/funnels/contracts.md).

The user requires blank/custom funnels and editable sales/ecommerce templates, independent campaigns attached to stages, optional automation, real event tracking and explanations. The user confirmed native forms/API, Calendly, Shopify and Resend as initial connectors, with LaunchPad owning sequence timing.

## Architectural findings

- A contact-stage field cannot model two enquiries/orders. Separate source-qualified business subjects from individual funnel runs.
- Source delivery identity, business-fact identity and journey identity differ. Preserve them and unknown matching explicitly.
- Current remote main has a substantial social worker and integrations through PR #34. The earlier local-checkout review was stale for this dependency. Reuse its durable protocol, not its social-specific data model.
- Legacy Campaign remains unowned and paid-only, including a database CHECK. Introduce an owned cross-channel identity rather than repurpose historical records.
- Calendly reschedules carry old/new invitee URIs; no universal webhook delivery ID is established by its sample contract.
- Shopify removed checkout IDs in API 2026-04; use checkout tokens. Refund existence is separate from a successful refund transaction.
- Resend idempotency lasts 24 hours. Local send identity, suppression and unknown-outcome handling must outlive provider guarantees.

## References and verification boundary

The [contract](../../docs/funnels/contracts.md) links the official provider sources and the current repository modules. The epic contains the full HubSpot Journey/Workflow comparison and original diagrams. Research involved source/document inspection, not live account access. Integration fixtures and release gates remain separate from real provider approval, consent and delivery evidence.
