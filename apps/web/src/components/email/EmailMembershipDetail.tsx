"use client";
import Link from "next/link";
import { useState } from "react";
import {
  EmailLayout,
  EmailPanel,
  EmailFeedback,
  EmailField,
  inputClass,
  buttonClass,
} from "./EmailLayout";
import { EmailConsentForm } from "./EmailRecipients";
import {
  dateLabel,
  emailRequest,
  shortId,
  useCommandKey,
  useEmailAction,
  useEmailResource,
  type EmailCampaign,
  type MembershipDetail,
} from "./emailUi";
type History = {
  send: {
    id: string;
    status: string;
    deliveryState: string;
    dueAt: string;
    expiresAt: string;
    acceptedAt: string | null;
    cancelRequestedAt: string | null;
  };
  attempts: {
    id: string;
    number: number;
    outcome: string;
    code: string | null;
    startedAt: string;
    completedAt: string | null;
  }[];
  receipts: {
    id: string;
    type: string;
    status: string;
    reason: string | null;
    occurredAt: string;
    receivedAt: string;
  }[];
};
function SendHistory({ id, onChange }: { id: string; onChange: () => void }) {
  const history = useEmailResource<History>(`/api/email/sends/${id}`),
    action = useEmailAction(),
    [providerId, setProviderId] = useState("");
  async function operation(kind: "retry" | "reconcile") {
    const value = await action.run(() =>
      emailRequest<{ outcome: string; code?: string }>(
        `/api/email/sends/${id}/${kind}`,
        "POST",
        kind === "reconcile" && providerId
          ? { providerMessageId: providerId }
          : {},
      ),
    );
    if (value) {
      action.setNotice(
        `${value.outcome.replaceAll("_", " ")}${value.code ? ` · ${value.code.replaceAll("_", " ")}` : ""}`,
      );
      history.reload();
      onChange();
    }
  }
  return (
    <details className="rounded-box border border-base-300 p-4">
      <summary className="cursor-pointer py-2 font-semibold">
        Delivery evidence · {shortId(id)}
      </summary>
      <div className="mt-3 space-y-4">
        <EmailFeedback
          error={history.error || action.error}
          notice={action.notice}
          busy={action.busy}
        />
        {history.data ? (
          <>
            <p>
              Provider acceptance: {history.data.send.status.toLowerCase()}.
              Delivery:{" "}
              {history.data.send.deliveryState === "UNKNOWN"
                ? "no delivery result received yet"
                : history.data.send.deliveryState.toLowerCase()}
              . Due {dateLabel(history.data.send.dueAt)} · Accepted{" "}
              {dateLabel(history.data.send.acceptedAt)}
            </p>
            {history.data.send.status === "UNKNOWN" ? (
              <div className="space-y-3">
                <p>
                  The provider may already have accepted this message.
                  Reconciliation reads positive evidence; it does not send
                  again.
                </p>
                <EmailField
                  label="Provider message ID (optional)"
                  hint="Use the ID from this original provider connection if it is known."
                >
                  {(field) => (
                    <input
                      id={field}
                      className={inputClass}
                      value={providerId}
                      onChange={(e) => setProviderId(e.target.value)}
                    />
                  )}
                </EmailField>
                <button
                  className={buttonClass}
                  type="button"
                  disabled={action.busy}
                  onClick={() => void operation("reconcile")}
                >
                  Reconcile original send
                </button>
              </div>
            ) : null}
            {history.data.send.status === "FAILED" ? (
              <>
                <p>
                  A retry requires a definitive retryable rejection, the
                  original request and a current sending window. The server
                  checks eligibility.
                </p>
                <button
                  className={buttonClass}
                  disabled={action.busy}
                  type="button"
                  onClick={() => void operation("retry")}
                >
                  Retry original request
                </button>
              </>
            ) : null}
            <ol className="space-y-2">
              {history.data.attempts.map((a) => (
                <li key={a.id}>
                  Attempt {a.number} · {a.outcome} · {dateLabel(a.startedAt)}
                  {a.code ? ` · ${a.code.replaceAll("_", " ")}` : ""}
                </li>
              ))}
            </ol>
            <ul className="space-y-2">
              {history.data.receipts.map((r) => (
                <li key={r.id}>
                  {r.type} · {r.status}
                  {r.reason ? ` · ${r.reason.replaceAll("_", " ")}` : ""}
                  <span className="block text-sm">
                    Occurred {dateLabel(r.occurredAt)} · Received{" "}
                    {dateLabel(r.receivedAt)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </details>
  );
}
export function EmailMembershipDetail({
  membershipId,
}: {
  membershipId: string;
}) {
  const resource = useEmailResource<MembershipDetail>(
      `/api/email/memberships/${membershipId}`,
    ),
    campaign = useEmailResource<EmailCampaign>(
      resource.data
        ? `/api/marketing-campaigns/${resource.data.membership.campaignId}`
        : null,
    ),
    action = useEmailAction(),
    command = useCommandKey(),
    [reason, setReason] = useState(""),
    [stopReason, setStopReason] = useState("");
  const member = resource.data?.membership,
    revision = campaign.data?.revisions?.find(
      (r) => r.id === member?.revisionId,
    );
  return (
    <EmailLayout
      title="Recipient sequence"
      description="Inspect one recipient’s pinned campaign version, timing, consent and delivery evidence."
      environment={campaign.data?.environment}
    >
      <EmailFeedback
        error={resource.error || campaign.error || action.error}
        notice={action.notice}
        busy={action.busy}
      />
      {resource.loading ? <p role="status">Loading sequence…</p> : null}
      {member && resource.data ? (
        <>
          <EmailPanel title={campaign.data?.name || "Campaign sequence"}>
            <Link
              className="link"
              href={`/email/campaigns/${member.campaignId}`}
            >
              Back to campaign
            </Link>
            <p className="mt-3">
              {member.status} · Cycle {member.cycle} · Published version{" "}
              {revision?.number || shortId(member.revisionId)}
            </p>
            <p className="mt-2">
              {member.scopeKind === "SUBJECT"
                ? `Business journey ${shortId(member.subjectId!)}`
                : `Contact ${shortId(member.contactId)}`}{" "}
              · Enrolled {dateLabel(member.startedAt)}
            </p>
            {member.stopReason ? (
              <p className="mt-2">Stop reason: {member.stopReason}</p>
            ) : null}
            <p className="mt-3">
              {resource.data.cadenceStarted
                ? "Scheduled sequence explicitly authorized."
                : "Enrolled only. Scheduled work has not been started."}
            </p>
            {!resource.data.cadenceStarted ? (
              <p className="mt-2 text-sm">
                Step timing uses the original enrollment time. Starting later
                does not reset delays or expired messages.
              </p>
            ) : null}
            {!resource.data.cadenceStarted && member.status === "ACTIVE" ? (
              <form
                className="mt-4 space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  const payload = { reason };
                  void action
                    .run(
                      () =>
                        emailRequest(
                          `/api/email/memberships/${membershipId}/start`,
                          "POST",
                          { ...payload, requestKey: command.keyFor(payload) },
                        ),
                      "Sequence authorized. The worker will process due steps using current consent, controls and send windows.",
                    )
                    .then((value) => {
                      if (value) {
                        command.reset();
                        resource.reload();
                      }
                    });
                }}
              >
                <EmailField label="Reason for starting this sequence">
                  {(id) => (
                    <input
                      id={id}
                      required
                      maxLength={500}
                      className={inputClass}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  )}
                </EmailField>
                <button
                  disabled={action.busy}
                  className="btn btn-primary min-h-11 normal-case"
                >
                  Start sequence
                </button>
              </form>
            ) : null}
            {member.status === "ACTIVE" ? (
              <div className="mt-5 space-y-3">
                <button
                  type="button"
                  className={buttonClass}
                  disabled={action.busy}
                  onClick={() =>
                    void action
                      .run(() =>
                        emailRequest<{ outcome: string; code?: string }>(
                          `/api/email/memberships/${membershipId}/dispatch`,
                          "POST",
                          {},
                        ),
                      )
                      .then((value) => {
                        if (value) {
                          action.setNotice(
                            `${value.outcome.replaceAll("_", " ")}${value.code ? ` · ${value.code.replaceAll("_", " ")}` : ""}`,
                          );
                          resource.reload();
                        }
                      })
                  }
                >
                  Send current message when eligible
                </button>
                <p className="text-sm">
                  This action cannot skip a wait or send window. Multi-step
                  sequences must be started explicitly.
                </p>
              </div>
            ) : null}
            {member.status === "ACTIVE" || member.status === "BLOCKED" ? (
              <form
                className="mt-5 space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void action
                    .run(
                      () =>
                        emailRequest(
                          `/api/email/memberships/${membershipId}/stop`,
                          "POST",
                          { reason: stopReason },
                        ),
                      "Sequence stopped. Messages already submitted may still arrive; uncertain sends remain available for reconciliation.",
                    )
                    .then((value) => {
                      if (value) resource.reload();
                    });
                }}
              >
                <EmailField label="Reason for stopping">
                  {(id) => (
                    <input
                      id={id}
                      required
                      maxLength={500}
                      className={inputClass}
                      value={stopReason}
                      onChange={(e) => setStopReason(e.target.value)}
                    />
                  )}
                </EmailField>
                <button disabled={action.busy} className={buttonClass}>
                  Stop this sequence
                </button>
              </form>
            ) : null}
          </EmailPanel>
          {revision ? (
            <EmailConsentForm
              key={`${member.contactId}:${revision.definition.subscriptionCategory}`}
              contactId={member.contactId}
              category={revision.definition.subscriptionCategory}
              onChanged={resource.reload}
            />
          ) : null}
          <EmailPanel title="Step history">
            <ol className="space-y-3">
              {resource.data.steps.map((step) => (
                <li key={step.id} className="rounded-box bg-base-200 p-4">
                  <h3 className="font-semibold">
                    {revision?.steps.find((s) => s.id === step.stepId)
                      ?.subject || `Message ${shortId(step.stepId)}`}{" "}
                    · {step.status}
                  </h3>
                  {step.reason ? (
                    <p className="mt-2">
                      {step.reason.replaceAll("_", " ").toLowerCase()}
                    </p>
                  ) : null}
                  <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                    <div>
                      <dt>Waiting since</dt>
                      <dd>{dateLabel(step.waitStartedAt)}</dd>
                    </div>
                    <div>
                      <dt>Due</dt>
                      <dd>{dateLabel(step.dueAt)}</dd>
                    </div>
                    <div>
                      <dt>Timeout / expiry</dt>
                      <dd>
                        {dateLabel(step.waitDeadlineAt || step.expiresAt)}
                      </dd>
                    </div>
                    <div>
                      <dt>Next check</dt>
                      <dd>{dateLabel(step.nextWakeAt)}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ol>
            {!resource.data.steps.length ? (
              <p>No scheduled steps have been started.</p>
            ) : null}
          </EmailPanel>
          <EmailPanel title="Enrollment reasons">
            <ul className="space-y-3">
              {resource.data.reasons.map((reason) => (
                <li
                  key={reason.id}
                  className="rounded-box border border-base-300 p-4"
                >
                  {reason.kind} · {reason.note || "Funnel stage association"}
                  <span className="mt-1 block text-sm">
                    Added {dateLabel(reason.createdAt)} ·{" "}
                    {reason.endedAt
                      ? `Ended ${dateLabel(reason.endedAt)}: ${reason.endReason}`
                      : "Active"}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-sm">
              Several stage or manual associations can support one membership.
              Removing one association does not necessarily stop the sequence.
            </p>
          </EmailPanel>
          <EmailPanel title="Delivery history">
            <div className="space-y-3">
              {resource.data.sends.map((send) => (
                <SendHistory
                  key={send.id}
                  id={send.id}
                  onChange={resource.reload}
                />
              ))}
            </div>
            {!resource.data.sends.length ? (
              <p>No send intent has been created.</p>
            ) : null}
          </EmailPanel>
          <button
            type="button"
            className={buttonClass}
            onClick={resource.reload}
          >
            Refresh sequence history
          </button>
        </>
      ) : null}
    </EmailLayout>
  );
}
