# Running approved social schedules automatically

The web app saves an approved revision and a delivery schedule to the database. The separate social worker waits for its due time, rechecks the customer's current authorization and content, and performs delivery. Signing out or closing the browser does not cancel the schedule. Starting the web app alone does not start this worker.

This runs the content and destinations the customer explicitly approved. It does not generate an ongoing campaign, approve AI output, or publish unscheduled drafts. A saved campaign cadence is planning information until individual posts are approved and scheduled.

## Shared runtime requirements

Deploy the same application revision and generated Prisma client for both processes. Apply all database migrations before starting them. The current worker runs TypeScript through `tsx`; its deployment must contain that package and the source files, not just the Next.js build output. The repository's full `npm ci` install supplies it; an installation omitting development dependencies does not currently include the worker launcher. Use Node 24.16.0 or a later Node 24 version supported by `package.json`.

Both web and worker need these matching settings:

| Setting | Required arrangement |
| --- | --- |
| `DATABASE_URL` | The same durable database. For SQLite, use an absolute URL such as `file:/var/lib/launchpad/database/app.db`; colocate web and worker on the same host and persistent local volume. |
| `APP_ORIGIN` | The same customer-facing HTTPS origin; explicit mock mode can use loopback HTTP. |
| `CONNECTION_MODE` | Explicit `mock` or `live`. A live failure never falls back to mock publication. |
| `CONNECTION_TOKEN_KEYS`, `CONNECTION_ACTIVE_KEY_ID` | The same credential-vault keyring and selected key, supplied through the secret store. |
| `SOCIAL_MEDIA_DIRECTORY` | The same persistent private media directory, outside the public web root. |
| `SOCIAL_MEDIA_PUBLIC_ORIGIN`, `SOCIAL_MEDIA_SIGNING_KEY` | A reachable media-serving web origin and the same signing key. The web app must remain available while providers fetch media. |
| `SOCIAL_PUBLISHING_ENABLED` | Explicit `true` only after publishing is ready; otherwise `false`. |
| `SOCIAL_APPROVED_PROVIDERS` | JSON array of reviewed provider/destination kinds. Start with `[]`. Only enable the destinations actually configured and validated. |

Install each selected provider's credentials and permissions in both runtimes. YouTube, Meta, TikTok, LinkedIn, and X have separate requirements in the [publishing setup guide](social-publishing-setup.md). TikTok needs its verified media configuration; X needs configured prices and owner budget policies. The web server also needs FFmpeg/`ffprobe` to inspect uploaded media. Customer accounts must be connected, selected, and authorized for social publishing. An ad account connection does not grant social publication permission.

A deployment config can contain the following non-secret settings. Replace the example hostname and paths to match the deployment; retain the disabled publishing defaults until rollout is approved:

```dotenv
APP_ORIGIN=https://marketing.example.com
DATABASE_URL=file:/var/lib/launchpad/database/app.db
CONNECTION_MODE=live
SOCIAL_MEDIA_DIRECTORY=/var/lib/launchpad/media
SOCIAL_MEDIA_PUBLIC_ORIGIN=https://marketing.example.com
SOCIAL_PUBLISHING_ENABLED=false
SOCIAL_APPROVED_PROVIDERS=[]
```

Supply the keyring, media-signing key, and provider credentials separately through your deployment secret mechanism. Do not commit the resulting environment file. If using the systemd example below, render the merged runtime environment to `/etc/launchpad/runtime.env` with root-only permissions, and use the same values in the web service. The current app consumes environment variables; it does not read systemd credential files directly.

## Linux systemd example

This example assumes a dedicated `launchpad` service account, the application checkout at `/srv/launchpad/current`, a Node 24 installation at `/opt/node24/bin/node`, and persistent writable storage under `/var/lib/launchpad`. Adjust those paths to the actual deployment. The same service account must be able to access both the database directory and media directory. Keeping database sidecar/journal files writable is necessary, not only the database file itself.

Save the following as `/etc/systemd/system/launchpad-social-worker.service`:

```ini
[Unit]
Description=Launchpad approved social delivery worker
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
User=launchpad
Group=launchpad
WorkingDirectory=/srv/launchpad/current
Environment=NODE_ENV=production
Environment=PATH=/opt/node24/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=/etc/launchpad/runtime.env
ExecStart=/opt/node24/bin/node --import tsx apps/web/scripts/social-worker.ts run
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=180
UMask=0077
NoNewPrivileges=true
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

`WorkingDirectory` makes module resolution deterministic; `Restart=on-failure` restarts an unexpected worker failure. Start limits prevent a persistent misconfiguration from causing unlimited restarts. These behaviors are documented in the official [systemd service reference source](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml). The example is deployment guidance; it does not install or start a service automatically.

After configuring storage, migrations, credentials, the reviewed destination allowlist, and the publication switch, an operator can start and inspect the service:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now launchpad-social-worker.service
sudo systemctl status launchpad-social-worker.service
sudo journalctl -u launchpad-social-worker.service --since "10 minutes ago"
```

The worker prints sanitized outcome/status codes. An idle worker normally prints nothing. Service uptime alone does not establish healthy publishing: also check overdue deliveries and `BLOCKED`, `FAILED`, or `UNCERTAIN` outcomes in Social Marketing. Repair exhausted restart limits with `systemctl reset-failed` only after correcting the underlying configuration.

For a local development session with Mockoon and its isolated shared environment already running, the equivalent command is:

```sh
npm run social:worker -- run
```

Keep that process running while testing a future schedule. `run-once` processes at most one currently eligible delivery and exits; it does not wait for a future schedule.

## Review and stopping behavior

In the UI, save the final post, approve its exact revision and destinations, select a future time and time zone, then confirm scheduling. Approval alone does not enqueue a delivery. The worker polls for due work approximately once a second when idle; provider processing and retries can delay completion beyond the selected time.

When updating deployment settings or keys, stop continuous workers first. Workers capture their configuration at startup; changing the secret store does not update a running process. For a temporary publishing stop:

1. Stop the supervised worker with `systemctl stop launchpad-social-worker.service`.
2. Set `SOCIAL_PUBLISHING_ENABLED=false` and/or remove affected destination kinds from `SOCIAL_APPROVED_PROVIDERS` in the shared configuration.
3. Reload/restart web and worker processes with the updated configuration before resuming normal operation.

A termination signal prevents new work after the current operation finishes; a request already sent to a provider may still publish. Use the existing cancellation controls for pending deliveries. Do not reset uncertain publication records or blindly resend them: the worker reconciles known provider outcomes with bounded checks. Review [social delivery recovery and key rotation](social-delivery.md) for recovery, backups, and reconciliation procedures.

## Automated evidence

Run the dedicated test from the repository root under supported Node 24:

```sh
node --import tsx --test tests/integration/social-approved-schedule.test.ts
```

It uses a fresh SQLite database, real application services, actual SDK HTTP calls to local Mockoon, inspected image media, and a separate continuous worker process. It verifies that scheduling an unapproved revision fails, the approved future delivery remains queued before its due time, the customer session is removed, and the worker completes delivery without a browser or an in-process dispatch call. It checks one provider publication, one delivery attempt, one create-cost reservation, an unchanged reviewed revision, and no duplicate publication during subsequent worker polling. Test-owned processes and temporary resources are cleaned up.

This is evidence for automatic execution against local provider fixtures. It does not establish a live provider's approval, permissions, customer grant, or publication outcome.
