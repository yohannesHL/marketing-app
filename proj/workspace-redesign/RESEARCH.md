# Launchpad workspace redesign

Approved by the user on 2026-10-14; implementation explicitly authorized.

Public `/` is product marketing. Authenticated `/dashboard` is the command center. A shared responsive shell gives desktop users a collapsible sidebar and mobile users a five-entry bottom bar. Primary navigation: Home, AI Copilot (forthcoming), Campaigns, Workflows (forthcoming), Content Studio, Affiliate Marketing (forthcoming), Social Marketing, Analytics & Insights (forthcoming). Brand kit belongs in Studio, audience segments in Campaigns, and channel connections in Settings. Unavailable features must be visibly unavailable rather than dead links.

Visual language: warm white, charcoal, muted green, restrained borders, compact controls, strong typography, tabular data, and consistent focus/loading/empty/error states. Preserve wizard structure, social calendar, manual composition, connection controls, consent and delivery safeguards.

Campaign flow: type, website URL and editable brief, goal/audience, applicable platforms, budget/schedule, tailored creatives, review and execution. Types are social, paid ads, email, and blog. Social executes an approved content plan using the existing worker; continuous autonomous invention of new content is outside this approved first implementation. Ads use configured Google/Meta integrations; mock mode stays explicit. Email/blog support drafting and clearly explain missing delivery integrations. All saved campaign records are customer-scoped; campaign lists survive refresh. Studio exposes real saved content, brand rules, and existing assets. Dashboard displays actual counts/status, with unavailable performance metrics clearly identified.

Validation: customer isolation and mutation origin checks; durable draft CRUD; type/platform filtering; wizard navigation and retained input; responsive sidebar and mobile navigation; existing Mockoon connection and social delivery journeys; keyboard focus, validation, reduced motion, and overflow checks. Never fabricate live performance or successful external execution.
