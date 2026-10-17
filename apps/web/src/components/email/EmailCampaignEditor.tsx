"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { CampaignDefinition } from "../../server/email/campaignDefinition";
import { validateSendWindow } from "../../server/email/emailTiming";
import {
  EmailLayout,
  EmailPanel,
  EmailField,
  EmailFeedback,
  inputClass,
  selectClass,
  buttonClass,
} from "./EmailLayout";
import { EmailStepEditor, EmailSendWindowEditor } from "./EmailStepEditor";
import { EmailCampaignSimulator } from "./EmailCampaignSimulator";
import { EmailCampaignMembers } from "./EmailRecipients";
import {
  defaultDefinition,
  emailRequest,
  newKey,
  useDirtyGuard,
  useEmailAction,
  useEmailResource,
  type EmailCampaign,
  type EmailConnection,
  type EmailSource,
  type Environment,
} from "./emailUi";
function Workspace({
  initial,
  environment,
}: {
  initial?: EmailCampaign;
  environment: Environment;
}) {
  const router = useRouter(),
    action = useEmailAction(),
    connections = useEmailResource<EmailConnection[]>(
      `/api/email/connections?environment=${environment}`,
    ),
    sources = useEmailResource<EmailSource[]>("/api/tracking/sources");
  const [campaign, setCampaign] = useState(initial),
    [name, setName] = useState(initial?.name || ""),
    [scope, setScope] = useState<"SUBJECT" | "CONTACT">(
      initial?.membershipScope || "SUBJECT",
    ),
    [definition, setDefinition] = useState<CampaignDefinition>(
      () => initial?.draft || defaultDefinition(),
    ),
    [selected, setSelected] = useState(0),
    [valid, setValid] = useState(true),
    [review, setReview] = useState(false),
    [view, setView] = useState("edit");
  const dirty = !campaign
    ? !!name || !!definition.steps[0]?.subject
    : JSON.stringify(definition) !== JSON.stringify(campaign.draft) ||
      name !== campaign.name;
  useDirtyGuard(dirty || !valid);
  const senders = (connections.data || []).flatMap((c) =>
      c.senders.map((s) => ({
        ...s,
        connectionName: c.name,
        connectionStatus: c.status,
      })),
    ),
    availableSources = (sources.data || []).filter(
      (s) => s.environment === environment && s.status === "ACTIVE",
    );
  async function save(e: FormEvent) {
    e.preventDefault();
    const result = await action.run(async () => {
      validateSendWindow({
        ...definition.sendWindow,
        timeZone: definition.timeZone,
      });
      if (!definition.senderId)
        throw new Error(
          "Choose a sender before saving. You can add an unverified sender in Email connections.",
        );
      const payload = { name, definition };
      return campaign
        ? emailRequest<EmailCampaign>(
            `/api/marketing-campaigns/${campaign.id}`,
            "PATCH",
            { ...payload, draftRevision: campaign.draftRevision },
          )
        : emailRequest<EmailCampaign>("/api/marketing-campaigns", "POST", {
            ...payload,
            environment,
            category: "EMAIL",
            membershipScope: scope,
          });
    }, "Campaign draft saved.");
    if (result) {
      setCampaign({ ...result, revisions: campaign?.revisions });
      setReview(false);
      if (!campaign) router.replace(`/email/campaigns/${result.id}`);
    }
  }
  async function reload() {
    if (
      dirty &&
      !window.confirm("Replace your unsaved edits with the latest saved draft?")
    )
      return;
    const result = await action.run(() =>
      emailRequest<EmailCampaign>(`/api/marketing-campaigns/${campaign!.id}`),
    );
    if (result) {
      setCampaign(result);
      setDefinition(result.draft);
      setName(result.name);
      setSelected(0);
      setReview(false);
    }
  }
  async function controls(value: unknown) {
    const result = await action.run(
      () =>
        emailRequest<EmailCampaign>(
          `/api/marketing-campaigns/${campaign!.id}/controls`,
          "PATCH",
          value,
        ),
      "Campaign control updated.",
    );
    if (result)
      setCampaign((c) => ({
        ...c!,
        enrolmentEnabled: result.enrolmentEnabled,
        dispatchEnabled: result.dispatchEnabled,
        status: result.status,
      }));
  }
  async function publish() {
    const result = await action.run(async () => {
      await emailRequest(
        `/api/marketing-campaigns/${campaign!.id}/publish`,
        "POST",
        { draftRevision: campaign!.draftRevision },
      );
      return emailRequest<EmailCampaign>(
        `/api/marketing-campaigns/${campaign!.id}`,
      );
    }, "Campaign version published. Existing recipients keep their pinned version. Enrollment and sending controls are unchanged.");
    if (result) {
      setCampaign((c) => ({
        ...c!,
        publishedRevisionId: result.publishedRevisionId,
        revisions: result.revisions,
        status: result.status,
        enrolmentEnabled: result.enrolmentEnabled,
        dispatchEnabled: result.dispatchEnabled,
      }));
      setReview(false);
    }
  }
  return (
    <EmailLayout
      title={campaign ? campaign.name : "Create an email campaign"}
      description="Write the messages and decide when each step becomes due. A funnel can link this campaign and explicitly enroll recipients."
      environment={environment}
      dirty={dirty || !valid}
    >
      <EmailFeedback
        error={action.error || connections.error || sources.error}
        notice={action.notice}
        busy={action.busy}
      />
      {campaign ? (
        <nav aria-label="Campaign views" className="flex flex-wrap gap-3">
          {["edit", "simulate", "recipients"].map((tab) => (
            <button
              type="button"
              key={tab}
              className={`${buttonClass} ${view === tab ? "btn-active" : ""}`}
              aria-pressed={view === tab}
              disabled={!valid && view !== tab}
              onClick={() => setView(tab)}
            >
              {tab === "edit"
                ? "Messages & settings"
                : tab === "simulate"
                  ? "No-send simulation"
                  : "Recipients & history"}
            </button>
          ))}
        </nav>
      ) : null}
      {view === "edit" ? (
        <>
          <form onSubmit={save} className="space-y-6">
            <fieldset disabled={action.busy} className="space-y-6">
              <EmailPanel title="Campaign details">
                <div className="grid gap-4 sm:grid-cols-2">
                  <EmailField label="Campaign name">
                    {(id) => (
                      <input
                        id={id}
                        required
                        maxLength={120}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className={inputClass}
                      />
                    )}
                  </EmailField>
                  <EmailField
                    label="Recipient scope"
                    hint="This choice is fixed after creation."
                  >
                    {(id) => (
                      <select
                        id={id}
                        disabled={!!campaign}
                        value={scope}
                        onChange={(e) =>
                          setScope(e.target.value as typeof scope)
                        }
                        className={selectClass}
                      >
                        <option value="SUBJECT">
                          Separate sequence per enquiry or purchase
                        </option>
                        <option value="CONTACT">
                          Shared sequence per contact
                        </option>
                      </select>
                    )}
                  </EmailField>
                  <EmailField label="Send from">
                    {(id) => (
                      <select
                        id={id}
                        required
                        value={definition.senderId}
                        onChange={(e) =>
                          setDefinition({
                            ...definition,
                            senderId: e.target.value,
                          })
                        }
                        className={selectClass}
                      >
                        <option value="">Choose a sender</option>
                        {definition.senderId &&
                        !senders.some((s) => s.id === definition.senderId) ? (
                          <option value={definition.senderId}>
                            Unavailable sender ·{" "}
                            {definition.senderId.slice(0, 8)}
                          </option>
                        ) : null}
                        {senders.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.address} · {s.connectionName} ·{" "}
                            {s.status.toLowerCase()}
                          </option>
                        ))}
                      </select>
                    )}
                  </EmailField>
                  <EmailField
                    label="Subscription category"
                    hint="Use a short category such as product-news. Each recipient needs separate consent for this category."
                  >
                    {(id) => (
                      <input
                        id={id}
                        required
                        pattern="[a-z][a-z0-9_-]{0,63}"
                        value={definition.subscriptionCategory}
                        onChange={(e) =>
                          setDefinition({
                            ...definition,
                            subscriptionCategory: e.target.value,
                          })
                        }
                        className={inputClass}
                      />
                    )}
                  </EmailField>
                </div>
                {!senders.length ? (
                  <p className="mt-4">
                    Add a sender in{" "}
                    <Link
                      className="link"
                      href={`/email/connections?environment=${environment}`}
                    >
                      Email connections
                    </Link>{" "}
                    before saving this draft. Verification is required before
                    publishing.
                  </p>
                ) : null}
              </EmailPanel>
              <EmailPanel title="Message sequence">
                <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
                  <div>
                    <ol className="space-y-2" aria-label="Campaign messages">
                      {definition.steps.map((step, index) => (
                        <li key={step.id}>
                          <button
                            type="button"
                            disabled={!valid && index !== selected}
                            className={`w-full rounded-box border p-3 text-left ${index === selected ? "border-primary bg-base-200" : "border-base-300"}`}
                            aria-current={
                              index === selected ? "step" : undefined
                            }
                            onClick={() => setSelected(index)}
                          >
                            <span className="block font-semibold">
                              Message {index + 1}
                            </span>
                            <span className="block break-words text-sm">
                              {step.subject || "Untitled message"}
                            </span>
                            <span className="mt-1 block text-xs">
                              {step.wait.kind.toLowerCase()} wait
                            </span>
                          </button>
                        </li>
                      ))}
                    </ol>
                    <button
                      type="button"
                      disabled={!valid || definition.steps.length >= 50}
                      className={`${buttonClass} mt-4 w-full`}
                      onClick={() => {
                        setDefinition({
                          ...definition,
                          steps: [
                            ...definition.steps,
                            {
                              id: newKey(),
                              subject: "",
                              text: "",
                              wait: { kind: "DURATION", seconds: 86400 },
                              expiresAfterDueSeconds: 604800,
                            },
                          ],
                        });
                        setSelected(definition.steps.length);
                      }}
                    >
                      Add message
                    </button>
                  </div>
                  <div className="min-w-0">
                    {definition.steps[selected] ? (
                      <>
                        <div className="mb-4 flex flex-wrap gap-2">
                          <button
                            type="button"
                            className={buttonClass}
                            disabled={selected === 0 || !valid}
                            onClick={() => {
                              const steps = [...definition.steps];
                              [steps[selected - 1], steps[selected]] = [
                                steps[selected],
                                steps[selected - 1],
                              ];
                              setDefinition({ ...definition, steps });
                              setSelected(selected - 1);
                            }}
                          >
                            Move earlier
                          </button>
                          <button
                            type="button"
                            className={buttonClass}
                            disabled={
                              selected === definition.steps.length - 1 || !valid
                            }
                            onClick={() => {
                              const steps = [...definition.steps];
                              [steps[selected], steps[selected + 1]] = [
                                steps[selected + 1],
                                steps[selected],
                              ];
                              setDefinition({ ...definition, steps });
                              setSelected(selected + 1);
                            }}
                          >
                            Move later
                          </button>
                          <button
                            type="button"
                            className={buttonClass}
                            disabled={definition.steps.length === 1}
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Remove message ${selected + 1} from this draft? Published versions remain unchanged.`,
                                )
                              ) {
                                setDefinition({
                                  ...definition,
                                  steps: definition.steps.filter(
                                    (_, i) => i !== selected,
                                  ),
                                });
                                setSelected(Math.max(0, selected - 1));
                                setValid(true);
                              }
                            }}
                          >
                            Remove message
                          </button>
                        </div>
                        <EmailStepEditor
                          key={definition.steps[selected].id}
                          step={definition.steps[selected]}
                          onChange={(step) =>
                            setDefinition({
                              ...definition,
                              steps: definition.steps.map((s, i) =>
                                i === selected ? step : s,
                              ),
                            })
                          }
                          sources={availableSources}
                          timeZone={definition.timeZone}
                          subjectScope={scope === "SUBJECT"}
                          onValidityChange={setValid}
                        />
                      </>
                    ) : null}
                  </div>
                </div>
              </EmailPanel>
              <EmailPanel title="Sending window">
                <EmailSendWindowEditor
                  definition={definition}
                  onChange={setDefinition}
                />
              </EmailPanel>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  className="btn btn-primary min-h-11 normal-case"
                  disabled={!valid}
                >
                  {campaign ? "Save draft" : "Create draft"}
                </button>
                <p role="status">
                  {dirty
                    ? "Unsaved edits"
                    : campaign
                      ? `Saved draft revision ${campaign.draftRevision}`
                      : "New draft"}
                </p>
                {campaign ? (
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() => void reload()}
                  >
                    Reload saved draft
                  </button>
                ) : null}
              </div>
            </fieldset>
          </form>
          {campaign ? (
            <EmailPanel title="Publication and delivery">
              <p>
                Publish a reviewed version for future enrollments. Existing
                sequences keep their current version. Publishing does not enroll
                recipients or start a manual sequence.
              </p>
              <div className="mt-4 flex flex-wrap gap-3">
                <button
                  type="button"
                  className="btn btn-primary min-h-11 normal-case"
                  disabled={dirty || !valid || action.busy}
                  onClick={() => setReview((v) => !v)}
                >
                  Review publication
                </button>
                <button
                  type="button"
                  className={buttonClass}
                  disabled={!campaign.publishedRevisionId || action.busy}
                  onClick={() =>
                    void controls({
                      enrolmentEnabled: !campaign.enrolmentEnabled,
                    })
                  }
                >
                  {campaign.enrolmentEnabled
                    ? "Pause new enrollments"
                    : "Enable new enrollments"}
                </button>
                <button
                  type="button"
                  className={buttonClass}
                  disabled={!campaign.publishedRevisionId || action.busy}
                  onClick={() =>
                    void controls({
                      dispatchEnabled: !campaign.dispatchEnabled,
                    })
                  }
                >
                  {campaign.dispatchEnabled
                    ? "Pause sending"
                    : "Enable sending"}
                </button>
              </div>
              <p className="mt-3">
                New enrollments:{" "}
                {campaign.enrolmentEnabled ? "enabled" : "paused"}. Sending:{" "}
                {campaign.dispatchEnabled ? "enabled" : "paused"}.
              </p>
              {dirty ? (
                <p className="mt-3">
                  Save the draft before reviewing publication.
                </p>
              ) : null}
              {review ? (
                <div className="mt-5 space-y-3 rounded-box bg-base-200 p-5">
                  <h3 className="text-lg font-semibold">
                    Publish draft revision {campaign.draftRevision}
                  </h3>
                  <p>
                    {environment} · {definition.steps.length} messages ·{" "}
                    {scope === "SUBJECT"
                      ? "separate business journeys"
                      : "one sequence per contact"}
                  </p>
                  <p>
                    Sender:{" "}
                    {senders.find((s) => s.id === definition.senderId)
                      ?.address || "Unavailable"}
                    . Category: {definition.subscriptionCategory}. Timezone:{" "}
                    {definition.timeZone}.
                  </p>
                  <p>
                    Sender verification and event source prerequisites are
                    checked at publication. Existing recipients will not be
                    moved or restarted. Current delivery controls remain
                    unchanged.
                  </p>
                  <button
                    type="button"
                    disabled={action.busy}
                    className="btn btn-primary min-h-11 normal-case"
                    onClick={() => void publish()}
                  >
                    Publish reviewed version
                  </button>
                </div>
              ) : null}
            </EmailPanel>
          ) : null}
        </>
      ) : null}
      {view === "simulate" && campaign ? (
        <EmailCampaignSimulator
          campaignId={campaign.id}
          definition={definition}
          sources={availableSources}
        />
      ) : null}
      {view === "recipients" && campaign ? (
        <EmailCampaignMembers campaign={campaign} />
      ) : null}
    </EmailLayout>
  );
}
export function EmailCampaignEditor({
  campaignId,
  environment = "TEST",
}: {
  campaignId?: string;
  environment?: Environment;
}) {
  const resource = useEmailResource<EmailCampaign>(
    campaignId ? `/api/marketing-campaigns/${campaignId}` : null,
  );
  if (!campaignId) return <Workspace environment={environment} />;
  if (!resource.data)
    return (
      <EmailLayout
        title="Email campaign"
        description="Loading your saved campaign and published versions."
      >
        <EmailFeedback error={resource.error} />
        {resource.loading ? (
          <p role="status">Loading campaign…</p>
        ) : (
          <button className={buttonClass} onClick={resource.reload}>
            Try loading again
          </button>
        )}
      </EmailLayout>
    );
  return (
    <Workspace
      key={campaignId}
      initial={resource.data}
      environment={resource.data.environment}
    />
  );
}
