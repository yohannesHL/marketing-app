"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import {
  EmailLayout,
  EmailFeedback,
  EmailPanel,
  EnvironmentPicker,
  buttonClass,
  EmailField,
  inputClass,
  selectClass,
} from "./EmailLayout";
import {
  useEmailResource,
  useEmailAction,
  emailRequest,
  type EmailCampaign,
  type Environment,
} from "./emailUi";
export function EmailCampaignList({
  environment,
}: {
  environment: Environment;
}) {
  const router = useRouter(),
    resource = useEmailResource<EmailCampaign[]>(
      `/api/marketing-campaigns?environment=${environment}`,
    ),
    action = useEmailAction(),
    [referenceName, setReferenceName] = useState(""),
    [referenceType, setReferenceType] = useState("PAID");
  async function createReference(event: FormEvent) {
    event.preventDefault();
    const result = await action.run(
      () =>
        emailRequest<EmailCampaign>("/api/marketing-campaigns", "POST", {
          name: referenceName,
          environment,
          category: referenceType,
        }),
      "Campaign reference created. It can be linked to funnel stages for attribution; it does not execute messages or ads.",
    );
    if (result) {
      setReferenceName("");
      resource.reload();
    }
  }
  return (
    <EmailLayout
      title="Email campaigns"
      description="Build a message sequence, connect it to a funnel, and see why each recipient is waiting or receiving an email."
      environment={environment}
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <EnvironmentPicker
          value={environment}
          disabled={action.busy}
          onChange={(v) => router.push(`/email?environment=${v}`)}
        />
        <Link
          className="btn btn-primary min-h-11 normal-case"
          href={`/email/create?environment=${environment}`}
        >
          Create email campaign
        </Link>
      </div>
      <EmailFeedback
        error={resource.error || action.error}
        notice={action.notice}
        busy={action.busy}
      />
      {resource.loading ? <p role="status">Loading campaigns…</p> : null}
      {resource.data?.filter((c) => c.category === "EMAIL").length === 0 ? (
        <EmailPanel title="Create your first sequence">
          <p>
            Start with one message, then add follow-ups or wait for a verified
            event. Connect a sender before publishing.
          </p>
          <Link
            className={`${buttonClass} mt-4`}
            href={`/email/connections?environment=${environment}`}
          >
            Set up an email connection
          </Link>
        </EmailPanel>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2">
        {resource.data
          ?.filter((c) => c.category === "EMAIL")
          .map((c) => (
            <article
              key={c.id}
              className="min-w-0 rounded-box border border-base-300 p-5"
            >
              <p className="text-sm">
                {c.status} ·{" "}
                {c.membershipScope === "SUBJECT"
                  ? "Separate business journeys"
                  : "Shared contact sequence"}
              </p>
              <h2 className="mt-2 break-words text-xl font-semibold">
                <Link className="link" href={`/email/campaigns/${c.id}`}>
                  {c.name}
                </Link>
              </h2>
              <p className="mt-3">
                New enrollments {c.enrolmentEnabled ? "enabled" : "paused"} ·
                Sending {c.dispatchEnabled ? "enabled" : "paused"}
              </p>
              <p className="mt-2 text-sm text-base-content/75">
                {c.publishedRevisionId
                  ? "Published version available"
                  : "Draft only"}{" "}
                · Draft revision {c.draftRevision}
              </p>
            </article>
          ))}
      </div>
      <EmailPanel title="Other campaign references">
        <p>
          Give paid, social or external campaigns a name so they can be
          associated with funnel stages. These references provide attribution
          only. Advertising and social execution remain in their own workspaces.
        </p>
        <details className="mt-4">
          <summary className="cursor-pointer py-3 font-semibold">
            Add a campaign reference
          </summary>
          <form onSubmit={createReference} className="mt-3">
            <fieldset
              disabled={action.busy}
              className="grid gap-4 sm:grid-cols-2"
            >
              <EmailField label="Campaign reference name">
                {(id) => (
                  <input
                    id={id}
                    required
                    maxLength={120}
                    className={inputClass}
                    value={referenceName}
                    onChange={(e) => setReferenceName(e.target.value)}
                  />
                )}
              </EmailField>
              <EmailField label="Reference type">
                {(id) => (
                  <select
                    id={id}
                    className={selectClass}
                    value={referenceType}
                    onChange={(e) => setReferenceType(e.target.value)}
                  >
                    <option value="PAID">Paid advertising</option>
                    <option value="SOCIAL">Social campaign</option>
                    <option value="EXTERNAL">External campaign</option>
                  </select>
                )}
              </EmailField>
              <button className={`${buttonClass} sm:col-span-2`}>
                Create campaign reference
              </button>
            </fieldset>
          </form>
        </details>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {resource.data
            ?.filter((c) => c.category !== "EMAIL")
            .map((c) => (
              <article
                key={c.id}
                className="min-w-0 rounded-box border border-base-300 p-4"
              >
                <h3 className="break-words font-semibold">{c.name}</h3>
                <p className="mt-2 text-sm">
                  {c.category} · Association only · No scheduled actions
                </p>
              </article>
            ))}
        </div>
      </EmailPanel>
    </EmailLayout>
  );
}
