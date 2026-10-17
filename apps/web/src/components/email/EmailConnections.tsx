"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  EmailLayout,
  EmailPanel,
  EmailField,
  EmailFeedback,
  EnvironmentPicker,
  inputClass,
  buttonClass,
} from "./EmailLayout";
import {
  dateLabel,
  emailRequest,
  useEmailAction,
  useEmailResource,
  type EmailConnection,
  type Environment,
} from "./emailUi";
function Setup({
  connection,
  webhookUrl,
  onUpdated,
}: {
  connection: EmailConnection;
  webhookUrl?: string;
  onUpdated: (url?: string) => void;
}) {
  const action = useEmailAction(),
    [secret, setSecret] = useState(""),
    [webhookId, setWebhookId] = useState(""),
    [apiKey, setApiKey] = useState("");
  async function update(value: unknown, notice: string) {
    const result = await action.run(
      () =>
        emailRequest<{ connection: EmailConnection; webhookUrl?: string }>(
          `/api/email/connections/${connection.id}`,
          "PATCH",
          value,
        ),
      notice,
    );
    if (result) {
      setSecret("");
      setApiKey("");
      onUpdated(result.webhookUrl);
    }
  }
  async function saveHook(e: FormEvent) {
    e.preventDefault();
    await update(
      { webhookSecret: secret, providerWebhookId: webhookId },
      "Webhook saved. Verify the sender to finish setup.",
    );
  }
  async function addSender(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget,
      data = new FormData(form);
    const value = {
      address: data.get("address"),
      name: data.get("name") || undefined,
      replyTo: data.get("replyTo") || undefined,
      domainId: data.get("domainId"),
    };
    if (
      await action.run(
        () =>
          emailRequest(
            `/api/email/connections/${connection.id}/senders`,
            "POST",
            value,
          ),
        "Sender added. Check it before publishing.",
      )
    ) {
      form.reset();
      onUpdated();
    }
  }
  return (
    <EmailPanel title={connection.name}>
      <div className="space-y-5">
        <p>
          {connection.status} ·{" "}
          {connection.webhookConfigured
            ? "Webhook configured"
            : "Webhook setup required"}{" "}
          · Last verified {dateLabel(connection.verifiedAt)}
        </p>
        <EmailFeedback {...action} />
        {webhookUrl ? (
          <div className="rounded-box bg-base-200 p-4">
            <EmailField
              label="Your webhook URL"
              hint="Copy this URL into your Resend webhook setup. It is shown only here; rotating it replaces the previous URL."
            >
              {(id) => (
                <input
                  id={id}
                  className={inputClass}
                  value={webhookUrl}
                  readOnly
                  onFocus={(e) => e.target.select()}
                />
              )}
            </EmailField>
            <button
              type="button"
              className={`${buttonClass} mt-3`}
              onClick={() =>
                void action.run(
                  () => navigator.clipboard.writeText(webhookUrl),
                  "Webhook URL copied.",
                )
              }
            >
              Copy webhook URL
            </button>
          </div>
        ) : null}
        <details
          className="rounded-box border border-base-300 p-4"
          open={!connection.webhookConfigured}
        >
          <summary className="cursor-pointer py-2 font-semibold">
            Connect the delivery webhook
          </summary>
          <p className="my-3">
            In Resend, create a webhook for this URL and select sent, delivered,
            delivery delayed, bounced, complained, failed, suppressed and
            suppression added events. Paste its ID and signing secret below.
          </p>
          <form onSubmit={saveHook} className="space-y-4">
            <fieldset disabled={action.busy} className="space-y-4">
              <EmailField label="Resend webhook ID">
                {(id) => (
                  <input
                    id={id}
                    required
                    value={webhookId}
                    onChange={(e) => setWebhookId(e.target.value)}
                    className={inputClass}
                  />
                )}
              </EmailField>
              <EmailField label="Webhook signing secret">
                {(id) => (
                  <input
                    id={id}
                    required
                    type="password"
                    autoComplete="off"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    className={inputClass}
                  />
                )}
              </EmailField>
              <button className="btn btn-primary min-h-11 normal-case">
                Save webhook settings
              </button>
            </fieldset>
          </form>
        </details>
        <div className="space-y-3">
          {connection.senders.map((sender) => (
            <article
              key={sender.id}
              className="rounded-box border border-base-300 p-4"
            >
              <h3 className="break-words font-semibold">
                {sender.name ? `${sender.name} · ` : ""}
                {sender.address}
              </h3>
              <p className="mt-2">
                {sender.status} · Checked {dateLabel(sender.verifiedAt)}
              </p>
              {sender.refreshErrorCode ? (
                <p className="mt-2">
                  Readiness needs attention:{" "}
                  {sender.refreshErrorCode.replaceAll("_", " ").toLowerCase()}.{" "}
                  {sender.refreshNextAttemptAt
                    ? `Next check ${dateLabel(sender.refreshNextAttemptAt)}.`
                    : ""}
                </p>
              ) : null}
              <button
                type="button"
                disabled={action.busy}
                className={`${buttonClass} mt-3`}
                onClick={() =>
                  void action
                    .run(
                      () =>
                        emailRequest(
                          `/api/email/senders/${sender.id}/check`,
                          "POST",
                          {},
                        ),
                      "Sender check completed.",
                    )
                    .then((value) => {
                      if (value) onUpdated();
                    })
                }
              >
                Verify sender {sender.address}
              </button>
            </article>
          ))}
        </div>
        <details
          open={!connection.senders.length}
          className="rounded-box border border-base-300 p-4"
        >
          <summary className="cursor-pointer py-2 font-semibold">
            Add a sender
          </summary>
          <p className="my-3">
            Use a verified sending domain from your Resend account. Sender
            identities are fixed once created; add another sender to change
            them.
          </p>
          <form onSubmit={addSender}>
            <fieldset
              disabled={action.busy}
              className="grid gap-4 sm:grid-cols-2"
            >
              <EmailField label="Sender email">
                {(id) => (
                  <input
                    id={id}
                    name="address"
                    type="email"
                    required
                    className={inputClass}
                  />
                )}
              </EmailField>
              <EmailField label="Sender name">
                {(id) => <input id={id} name="name" className={inputClass} />}
              </EmailField>
              <EmailField label="Reply-to email (optional)">
                {(id) => (
                  <input
                    id={id}
                    name="replyTo"
                    type="email"
                    className={inputClass}
                  />
                )}
              </EmailField>
              <EmailField label="Resend domain ID">
                {(id) => (
                  <input
                    id={id}
                    name="domainId"
                    required
                    className={inputClass}
                  />
                )}
              </EmailField>
              <button className="btn btn-primary min-h-11 normal-case sm:col-span-2">
                Add sender
              </button>
            </fieldset>
          </form>
        </details>
        <details className="rounded-box border border-base-300 p-4">
          <summary className="cursor-pointer py-2 font-semibold">
            Connection controls
          </summary>
          <p className="my-3">
            Changing credentials, status or webhook URL requires another sender
            check. Existing campaign versions keep this connection.
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              disabled={action.busy}
              className={buttonClass}
              onClick={() =>
                void update(
                  {
                    status:
                      connection.status === "ACTIVE" ? "PAUSED" : "ACTIVE",
                  },
                  "Connection status updated.",
                )
              }
            >
              {connection.status === "ACTIVE"
                ? "Pause connection"
                : "Activate connection"}
            </button>
            <button
              type="button"
              disabled={action.busy}
              className={buttonClass}
              onClick={() => {
                if (
                  window.confirm(
                    "Replace the webhook URL? You must update the webhook in Resend before new delivery events arrive.",
                  )
                )
                  void update(
                    { rotateIngress: true },
                    "Webhook URL replaced. Update Resend and verify the sender.",
                  );
              }}
            >
              Replace webhook URL
            </button>
          </div>
          <form
            className="mt-5 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void update(
                { apiKey },
                "API key replaced. Verify the sender again.",
              );
            }}
          >
            <EmailField label="Replacement Resend API key">
              {(id) => (
                <input
                  id={id}
                  type="password"
                  autoComplete="off"
                  required
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className={inputClass}
                />
              )}
            </EmailField>
            <button disabled={action.busy} className={buttonClass}>
              Replace API key
            </button>
          </form>
        </details>
      </div>
    </EmailPanel>
  );
}
export function EmailConnections({
  environment,
}: {
  environment: Environment;
}) {
  const router = useRouter(),
    resource = useEmailResource<EmailConnection[]>(
      `/api/email/connections?environment=${environment}`,
    ),
    action = useEmailAction(),
    [urls, setUrls] = useState<Record<string, string>>({});
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget,
      data = new FormData(form);
    const result = await action.run(
      () =>
        emailRequest<{ connection: EmailConnection; webhookUrl: string }>(
          "/api/email/connections",
          "POST",
          { environment, name: data.get("name"), apiKey: data.get("apiKey") },
        ),
      "Connection created. Complete the webhook and sender setup below.",
    );
    if (result) {
      form.reset();
      setUrls((v) => ({ ...v, [result.connection.id]: result.webhookUrl }));
      resource.reload();
    }
  }
  return (
    <EmailLayout
      title="Email connections"
      description="Connect Resend, receive delivery events, and verify the identity your campaigns send from."
      environment={environment}
    >
      <EnvironmentPicker
        value={environment}
        disabled={action.busy}
        onChange={(v) => router.push(`/email/connections?environment=${v}`)}
      />
      <EmailFeedback
        error={resource.error || action.error}
        notice={action.notice}
        busy={action.busy}
      />
      <EmailPanel title="Add a Resend connection">
        <form onSubmit={create}>
          <fieldset
            disabled={action.busy}
            className="grid gap-4 sm:grid-cols-2"
          >
            <EmailField label="Connection name">
              {(id) => (
                <input
                  id={id}
                  name="name"
                  required
                  maxLength={120}
                  placeholder="Company email"
                  className={inputClass}
                />
              )}
            </EmailField>
            <EmailField
              label="Resend API key"
              hint="Setup and reconciliation require full access. Keys are stored securely and are never shown again."
            >
              {(id) => (
                <input
                  id={id}
                  name="apiKey"
                  required
                  type="password"
                  autoComplete="off"
                  className={inputClass}
                />
              )}
            </EmailField>
            <button className="btn btn-primary min-h-11 normal-case sm:col-span-2">
              Create connection
            </button>
          </fieldset>
        </form>
      </EmailPanel>
      {resource.loading ? <p role="status">Loading connections…</p> : null}
      {resource.data?.map((connection) => (
        <Setup
          key={connection.id}
          connection={connection}
          webhookUrl={urls[connection.id]}
          onUpdated={(url) => {
            if (url) setUrls((v) => ({ ...v, [connection.id]: url }));
            resource.reload();
          }}
        />
      ))}
    </EmailLayout>
  );
}
