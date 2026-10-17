# Workspace redesign progress

Status: implemented and validated locally on 2026-10-14. Live-provider rollout remains subject to the existing setup and approval requirements.

- [x] Existing app audited; architecture and scope approved.
- [x] Shared shell, landing and visual system.
- [x] Persistent customer campaign library and studio.
- [x] Type-aware wizard and execution handoffs.
- [x] Automated and browser validation against Mockoon.

Work uses the clean managed checkout; the user's original checkout remains untouched. Existing Mockoon demo is a separate snapshot and will receive validated updates.

## Validation

- `npm run test:security`: 425 passed, zero failures or skips.
- `npx tsc --noEmit -p apps/web/tsconfig.json`: passed.
- `npm run build --workspace @launchpad/web`: passed, with nonblocking existing social-effect and native private-image lint warnings.
- Updated E2E scenarios and page objects typecheck. The automated browser suite was not executed in this session; browser interaction used the Codex in-app browser.
- In-app browser: created and saved a social campaign, reviewed/applied mock writing suggestions, reloaded the creative step, finished the campaign, prepared and linked a post, and saved/reloaded brand guidelines.
- Approved and submitted one exact seven-destination mock revision. The actual background worker returned Published for YouTube, Facebook, Instagram, TikTok, LinkedIn member, LinkedIn organization, and X; each completed with one attempt. No real posts or ad spend.
- Google and Meta mock OAuth callback/discovery both completed through Integrations.
- Desktop and 390px mobile checks covered landing, dashboard, wizard, campaign calendar, integrations, quick actions, and mobile More navigation. Fixed table overflow, wizard page insets, and mobile heading sizing.
- Independent review corrected manual shared-caption inheritance, discard navigation, and recovery when saving a post succeeds but linking it to a campaign fails. The UI now retains a durable post URL and offers an association-only retry.

## Execution boundaries

The redesign does not imply new live publishing approvals. Social posts execute only after exact revision review, provider controls, and scheduling. Continuous autonomous generation is not enabled. Paid campaigns persist plans and check account readiness; live ad creation remains disabled. Email and blog campaigns are drafting workspaces. Writing assistance is explicitly synthetic in mock mode; the October 17 follow-up adds a configurable OpenAI adapter (see below). ROI and attribution are not fabricated. Copilot, Workflows, Affiliate, Analytics, and mind-map entries are visibly forthcoming.

See [workspace guide](../../docs/workspace-redesign.md) for routes, storage, and setup.

## October 17 — real AI and approved automatic delivery

- Added server-side OpenAI Responses integration for enhanced briefs and distinct channel copy, video scripts, and visual directions. Suggestions require explicit application; generation never approves or schedules a post. Finished media still requires upload.
- Added owner-scoped, durable minute/day request quotas, strict output validation, bounded timeouts/responses, safe errors, and missing-key handling. AI mode is independent of Mockoon connection mode.
- Protected pending AI/brand lookups against campaign navigation and replacement requests. Campaign post reviews refresh active delivery status.
- Added [AI setup](../../docs/campaign-ai-setup.md) and [worker operations](../../docs/social-worker-operations.md) guidance.
- Full integration/security suite: **435 passed**, no failures or skips on the final run. An earlier concurrent build/test run timed out one process-cleanup test; both its isolated rerun and the full rerun passed.
- Actual worker + Mockoon test confirms a future approved post waits until due, survives sign-out, publishes once, and preserves the exact approved revision.
- Final production build, TypeScript, and targeted wizard lint passed; the build retains the existing social-effect and private-image warnings. No real OpenAI key was available, so provider contract tests use controlled responses; live generation/writing quality remains unverified.
- Visual recheck was blocked by the browser URL policy when reopening its old error tab. The automated browser suite was not run.

## October 17 — Codex through llm-gw

- Added `llm-gw` mode using `LLM_BASE_URL`, `LLM_MODEL`, and `LLM_API_KEY`. The configured target is `http://127.0.0.1:4000` with `codex/fast`.
- Uses the gateway's documented Chat Completions strict JSON contract, omitting unsupported token/sampling controls. Completion status and application content rules are checked before presenting drafts. No fallback to direct OpenAI or mock output on gateway failure.
- Added root/v1 URL normalization, HTTPS-or-loopback URL validation, 120-second timeout, and matching UI timeout. Existing approval, scheduling, and usage quotas remain active.
- Non-secret local configuration saved in `apps/web/.env.local`; added local-env ignore rules. No gateway credential stored.
- Focused workspace, AI, and campaign-state tests: 31 passed. TypeScript and production build passed (existing lint warnings remain).
- Gateway is reachable; unauthenticated health and authentication with the supplied example value returned HTTP 401. Live generation requires the actual gateway master key.

## October 17 — live gateway verification

- With explicit user authorization, read the active remote llm-gw master key and installed it in the ignored `apps/web/.env.local` with mode 0600. Credential value was not displayed or committed. Authenticated model discovery confirmed `codex/fast`.
- Live authenticated workspace API pilot passed: enhanced readable brief in 6.1 seconds; all six social creatives in 16.1 seconds; saved/reloaded drafts; two quota reservations; zero social posts/deliveries. Synthetic content only.
- The initial live call exposed serialized JSON inside the brief string. Tightened instructions/schema description and added output validation plus a regression test; the rerun produced readable plain text.
- Focused automated tests: 32 passed. Added an explicit opt-in live pilot and sanitized [evidence](../../docs/evidence/campaign-ai/llm-gw-live.json).
