# Real campaign AI and automatic social delivery

Campaign brief enhancement and creative generation now support Codex through llm-gw, with OpenAI available as an optional alternative. Suggestions are previews: the customer applies them, edits the draft, and saves it before preparing social posts. Generation never creates approvals, delivery jobs, or provider permissions.

## What you need to configure

1. Keep the remote llm-gw service available through the local tunnel on port 4000. Its configured `codex/fast` profile supplies the model; this application does not need a separate OpenAI key for that route.
2. Supply these variables to the **web process** through your secret store. For local Next.js development, use the ignored `apps/web/.env.local`. `LLM_API_KEY` must be the actual gateway master key; the text `replace-with-the-llm-gw-master-key` is only a placeholder. Do not paste the key into the UI or commit it.

```dotenv
WORKSPACE_AI_MODE=llm-gw
LLM_BASE_URL=http://127.0.0.1:4000
LLM_MODEL=codex/fast
LLM_API_KEY=your-gateway-master-key
AI_DAILY_REQUEST_LIMIT=50
AI_MINUTE_REQUEST_LIMIT=5
```

3. Apply all migrations, including `20261017000000_workspace_ai`, to the same configured application database and regenerate Prisma. From `apps/web`, use your normal deployment environment with `npx prisma migrate deploy` and `npx prisma generate`. Restart the web process after changing AI configuration.
4. Save your voice, audience, and rules in Content Studio → Brand kit. In the wizard, enter a campaign name, website, and factual brief, then select **Enhance brief**. On Creatives, select **Generate drafts**. Review the preview and apply it explicitly.

The gateway adapter calls `/v1/chat/completions` using `messages` and strict `response_format.json_schema`. It sends no tools, sampling parameters, `store`, `max_tokens`, or `max_completion_tokens`; the direct Codex route rejects unsupported parameters. The gateway's configured profile controls model reasoning and generation behavior. The application validates completed JSON and content limits before presenting a preview.

`LLM_BASE_URL` accepts a root URL or a URL ending in `/v1`. HTTP is allowed only for loopback (`localhost`, `127.0.0.1`, or `[::1]`); remote URLs must use HTTPS. Credentials, queries, fragments, and other paths in the URL are rejected. Redirects are disabled. Routing is server configuration and cannot be changed by a campaign request. In a container, loopback refers to that container; arrange the tunnel in the web process's network environment.

`WORKSPACE_AI_MODE` is independent of `CONNECTION_MODE`. Use real gateway AI with `CONNECTION_MODE=mock` to evaluate writing without publishing to real platforms. `WORKSPACE_AI_MODE=mock` uses deterministic fixtures and displays demo labels. `disabled` leaves manual drafting available. If the mode is omitted, a configured `LLM_BASE_URL` selects the gateway; otherwise existing Mockoon environments retain demo assistance and other environments disable it. Missing credentials or provider errors never silently substitute mock output.

For optional direct OpenAI access, set `WORKSPACE_AI_MODE=openai`, `OPENAI_API_KEY`, and `OPENAI_MODEL` (default `gpt-4.1-mini`). That adapter uses [Responses API structured output](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses). This alternative is not required for llm-gw.

## What AI generates

The provider receives the current campaign name, URL, brief, goal, audience, selected platforms, and that customer's saved brand name, voice, audience, rules, and colors. It does not receive connection tokens, other customers' data, saved post approvals, or media files. The URL is context, not a crawl instruction. The gateway has its own tracing and provider data policies; review its configured logging/retention before sending customer briefs. The optional direct OpenAI route sends `store: false`; this is not a promise of zero retention.

Brief enhancement clarifies the supplied offer and facts. Creative generation produces channel-specific titles, captions/copy, and calls to action. Video channels additionally get scripts and visual direction. Image channels get visual direction. Production notes have separate editable fields and are not inserted into public captions. Finished image/video generation is not part of this adapter; upload finished media in the composer before review.

Google search headline/description lengths, YouTube titles, X weighted text length, supported formats, exact selected-channel coverage, and overall content size are checked before returning a preview. These checks do not certify provider policy compliance or factual correctness. Publication still uses the existing provider-specific validation.

## Request limits and failures

The database reserves each real AI request against per-customer UTC minute and day windows before calling the configured provider. Defaults are 5 per minute and 50 per day. Multiple web processes share these limits. Provider errors and timeouts remain counted because the provider may already have processed the request. The gateway adapter uses a 120-second timeout; the optional direct OpenAI adapter uses 45 seconds. Neither makes automatic retries. The configured request count is not a monetary spending limit; set the project's billing controls separately.

Keys, raw provider errors, and full prompts are not written to application logs by this adapter. Authentication, same-origin mutation checks, request-size limits, response-size limits, and owner-scoped brand access apply. A refused, malformed, truncated, over-limit, or timed-out response leaves the customer's original content unchanged.

## Run approved social campaigns automatically

1. Save the campaign and prepare its social post. Choose the connected accounts and upload the finished media.
2. Review each exact destination variant, including public copy, media, privacy, disclosures, and provider settings. Approve the saved revision.
3. Choose **Schedule for later**, the time zone, and the exact publication time. Confirm the schedule. For immediate delivery, explicitly confirm **Publish now**.
4. Keep the separate worker running with `npm run social:worker -- run`. It uses the same database, media storage, provider configuration, and credential keys as the web process. See [supervised worker setup](social-worker-operations.md) for an operations-ready example.

After schedule confirmation, the browser may close and the customer may sign out. The worker waits for the due time, rechecks permissions and the approved revision, publishes, and records the outcome for each destination. Campaign reviews refresh active delivery status automatically while open. The worker does not generate replacement content after approval. Editing an approved post requires review again. A planned cadence alone does not authorize recurring creation of unreviewed posts; prepare and approve every post in the schedule.

For real delivery, you still need the provider applications, customer OAuth connections, approved permissions, media hosting, and explicit publishing configuration described in [social publishing setup](social-publishing-setup.md). AI credentials do not authorize social posting or ad spend.

## Verification

`tests/integration/workspace-ai.test.ts` exercises both real adapters' HTTP contracts with a controlled provider response, failures/refusals, output validation, tenant scoping, no-publishing behavior, and durable quota enforcement. `tests/integration/social-approved-schedule.test.ts` starts the actual worker and Mockoon, rejects unapproved scheduling, schedules a future post, signs out, verifies no early attempt, then checks exactly one successful publication without a browser.

Live verification completed on October 17, 2026 against the remote llm-gw service through `http://127.0.0.1:4000`, using `codex/fast`. The authorized gateway credential is installed in the ignored local environment file with owner-only permissions; it is not included in this repository or evidence. A synthetic customer's authenticated workspace API enhanced a brief (about 6 seconds) and generated distinct YouTube, Facebook, Instagram, TikTok, LinkedIn, and X drafts (about 16 seconds). The drafts passed format/content limits, saved and reloaded unchanged, consumed two quota reservations, and created no social posts or delivery jobs. The test also caught and corrected a plain-text brief formatting problem.

See [sanitized live output](evidence/campaign-ai/llm-gw-live.json). This verifies one synthetic campaign through the real gateway; it does not certify every generated claim or enable live social publication.

To rerun the opt-in live pilot from the repository root (makes two real generation requests):

```sh
RUN_LIVE_CAMPAIGN_AI=1 node --env-file=apps/web/.env.local --import tsx tests/support/campaign-ai-live-check.mts
```

The pilot uses an isolated temporary database and synthetic customer, checks quota accounting and absence of publishing, writes the sanitized output evidence, and cleans up its database. It does not change the application's customer campaigns.
