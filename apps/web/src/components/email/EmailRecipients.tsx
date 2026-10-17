"use client";
import Link from "next/link";
import { useState } from "react";
import {
  EmailPanel,
  EmailField,
  EmailFeedback,
  inputClass,
  selectClass,
  buttonClass,
} from "./EmailLayout";
import { ExactDateField } from "./EmailStepEditor";
import {
  dateLabel,
  emailRequest,
  recipientLabel,
  shortId,
  useCommandKey,
  useEmailAction,
  useEmailResource,
  type ContactOption,
  type EmailCampaign,
  type Environment,
  type Membership,
  type Policy,
  type SubjectOption,
} from "./emailUi";
export type RecipientSelection = {
  contactId: string;
  subjectId?: string;
  contact: ContactOption;
};
export function EmailRecipientPicker({
  environment,
  scope,
  onChange,
}: {
  environment: Environment;
  scope: "SUBJECT" | "CONTACT";
  onChange: (value: RecipientSelection | null) => void;
}) {
  const [query, setQuery] = useState(""),
    [selected, setSelected] = useState(""),
    [cursor, setCursor] = useState<string | undefined>();
  const contacts = useEmailResource<{
      contacts: ContactOption[];
      nextCursor: string | null;
    }>(
      scope === "CONTACT"
        ? `/api/tracking/contacts?environment=${environment}&query=${encodeURIComponent(query)}${cursor ? `&cursor=${cursor}` : ""}`
        : null,
    ),
    subjects = useEmailResource<SubjectOption[]>(
      scope === "SUBJECT"
        ? `/api/tracking/subjects?environment=${environment}`
        : null,
    );
  const choices =
    scope === "CONTACT"
      ? (contacts.data?.contacts || [])
          .filter((c) => c.email)
          .map((c) => ({
            id: c.id,
            label: recipientLabel(c),
            value: { contactId: c.id, contact: c },
          }))
      : (subjects.data || [])
          .filter(
            (s) =>
              s.contact?.email &&
              `${s.contact.name || ""} ${s.contact.email} ${s.id}`
                .toLowerCase()
                .includes(query.toLowerCase()),
          )
          .map((s) => ({
            id: s.id,
            label: `${recipientLabel(s.contact!)} · ${s.kind.toLowerCase()} ${shortId(s.id)}`,
            value: {
              contactId: s.contactId!,
              subjectId: s.id,
              contact: s.contact!,
            },
          }));
  return (
    <div className="space-y-3">
      <EmailField
        label="Find a recipient"
        hint={
          scope === "SUBJECT"
            ? "Choose the specific enquiry or purchase. A person can have several separate journeys."
            : "This campaign shares one active sequence for each contact."
        }
      >
        {(id) => (
          <input
            id={id}
            type="search"
            className={inputClass}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(undefined);
              setSelected("");
              onChange(null);
            }}
          />
        )}
      </EmailField>
      <EmailField
        label={
          scope === "SUBJECT"
            ? "Business journey recipient"
            : "Contact recipient"
        }
      >
        {(id) => (
          <select
            id={id}
            required
            className={selectClass}
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              onChange(
                choices.find((c) => c.id === e.target.value)?.value || null,
              );
            }}
          >
            <option value="">Choose a recipient with an email address</option>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        )}
      </EmailField>
      {contacts.loading || subjects.loading ? (
        <p role="status">Loading recipients…</p>
      ) : null}
      <EmailFeedback error={contacts.error || subjects.error} />
      {contacts.data?.nextCursor ? (
        <button
          className={buttonClass}
          type="button"
          onClick={() => {
            setCursor(contacts.data!.nextCursor!);
            setSelected("");
            onChange(null);
          }}
        >
          Next recipients
        </button>
      ) : null}
      {cursor ? (
        <button
          className={buttonClass}
          type="button"
          onClick={() => {
            setCursor(undefined);
            setSelected("");
            onChange(null);
          }}
        >
          First recipients
        </button>
      ) : null}
      {!contacts.loading && !subjects.loading && !choices.length ? (
        <p>
          No matching recipients with an email address. Identify a recipient
          through your{" "}
          <Link className="link" href="/tracking">
            tracking source
          </Link>{" "}
          first.
        </p>
      ) : null}
    </div>
  );
}
export function EmailConsentForm({
  contactId,
  category,
  onChanged,
}: {
  contactId: string;
  category: string;
  onChanged?: () => void;
}) {
  const policy = useEmailResource<Policy>(
      `/api/email/policy?contactId=${encodeURIComponent(contactId)}&category=${encodeURIComponent(category)}`,
    ),
    action = useEmailAction(),
    command = useCommandKey(),
    [operation, setOperation] = useState("OPT_IN"),
    [reason, setReason] = useState(""),
    [source, setSource] = useState(""),
    [purpose, setPurpose] = useState(""),
    [observedAt, setObservedAt] = useState(() => new Date().toISOString()),
    [release, setRelease] = useState("ADMIN");
  return (
    <div className="space-y-4 rounded-box border border-base-300 p-4">
      <h3 className="font-semibold">Email permission · {category}</h3>
      <EmailFeedback
        error={policy.error || action.error}
        notice={action.notice}
        busy={action.busy}
      />
      {policy.data ? (
        <>
          <p>
            {policy.data.state.replaceAll("_", " ")} ·{" "}
            {policy.data.eligible
              ? "Eligible under this category’s permission policy"
              : "Not eligible under this category’s permission policy"}
          </p>
          {policy.data.holds.length ? (
            <ul className="list-disc pl-5">
              {policy.data.holds.map((h) => (
                <li key={`${h.category}:${h.reason}`}>
                  {h.reason.replaceAll("_", " ")} ·{" "}
                  {h.category === "*" ? "all categories" : h.category}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      <details>
        <summary className="cursor-pointer py-2 font-medium">
          Record a permission or suppression change
        </summary>
        <form
          className="mt-4 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const payload = {
              contactId,
              category,
              action: operation,
              reason: operation === "RELEASE" ? release : reason,
              provenance: {
                source,
                purpose,
                observedAt,
                ...(operation === "RELEASE" ? { note: reason } : {}),
              },
            };
            void action
              .run(
                () =>
                  emailRequest<Policy>("/api/email/policy", "POST", {
                    ...payload,
                    requestKey: command.keyFor(payload),
                  }),
                "Permission policy updated. Enrollment and sequence start are separate actions.",
              )
              .then((value) => {
                if (value) {
                  command.reset();
                  policy.reload();
                  onChanged?.();
                }
              });
          }}
        >
          <fieldset disabled={action.busy} className="space-y-4">
            <EmailField label="Permission action">
              {(id) => (
                <select
                  id={id}
                  className={selectClass}
                  value={operation}
                  onChange={(e) => setOperation(e.target.value)}
                >
                  <option value="OPT_IN">Record explicit opt-in</option>
                  <option value="OPT_OUT">Opt out of this category</option>
                  <option value="BLOCK">Add an administrator hold</option>
                  <option value="RELEASE">Release a named hold</option>
                </select>
              )}
            </EmailField>
            {operation === "RELEASE" ? (
              <EmailField
                label="Hold to release"
                hint="Opt-out is removed only by a separate explicit opt-in. Releasing a hold does not grant consent."
              >
                {(id) => (
                  <select
                    id={id}
                    className={selectClass}
                    value={release}
                    onChange={(e) => setRelease(e.target.value)}
                  >
                    {[
                      "ADMIN",
                      "HARD_BOUNCE",
                      "COMPLAINT",
                      "PROVIDER_SUPPRESSION",
                    ].map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                )}
              </EmailField>
            ) : null}
            <EmailField label="Reason for this change">
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
            <EmailField
              label="Evidence source"
              hint="For example: signed registration form or a recorded recipient request."
            >
              {(id) => (
                <input
                  id={id}
                  required
                  maxLength={100}
                  className={inputClass}
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                />
              )}
            </EmailField>
            <EmailField label="Purpose covered by this evidence">
              {(id) => (
                <input
                  id={id}
                  required
                  maxLength={200}
                  className={inputClass}
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                />
              )}
            </EmailField>
            <ExactDateField
              label="Evidence recorded at"
              value={observedAt}
              zone="UTC"
              onChange={setObservedAt}
            />
            <button className={buttonClass}>Save permission change</button>
          </fieldset>
        </form>
      </details>
    </div>
  );
}
export function EmailCampaignMembers({
  campaign,
}: {
  campaign: EmailCampaign;
}) {
  const action = useEmailAction(),
    command = useCommandKey(),
    [cursor, setCursor] = useState<string>(),
    [recipient, setRecipient] = useState<RecipientSelection | null>(null),
    [reason, setReason] = useState(""),
    [newCycle, setNewCycle] = useState(false);
  const members = useEmailResource<{
      memberships: Membership[];
      nextCursor: string | null;
    }>(
      `/api/marketing-campaigns/${campaign.id}/memberships${cursor ? `?cursor=${cursor}` : ""}`,
    ),
    revision = campaign.revisions?.find(
      (r) => r.id === campaign.publishedRevisionId,
    );
  return (
    <EmailPanel title="Recipients and sequences">
      <EmailFeedback
        error={members.error || action.error}
        notice={action.notice}
        busy={action.busy}
      />
      {campaign.publishedRevisionId ? (
        <details>
          <summary className="cursor-pointer py-3 font-semibold">
            Enroll a recipient
          </summary>
          <div className="mt-4 space-y-5">
            <EmailRecipientPicker
              environment={campaign.environment}
              scope={campaign.membershipScope}
              onChange={setRecipient}
            />
            {recipient && revision ? (
              <EmailConsentForm
                key={`${recipient.contactId}:${revision.definition.subscriptionCategory}`}
                contactId={recipient.contactId}
                category={revision.definition.subscriptionCategory}
              />
            ) : null}
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (!recipient) return;
                const payload = {
                  contactId: recipient.contactId,
                  ...(recipient.subjectId
                    ? { subjectId: recipient.subjectId }
                    : {}),
                  revisionId: campaign.publishedRevisionId,
                  reason,
                  newCycle,
                };
                void action
                  .run(
                    () =>
                      emailRequest<{ membership: Membership }>(
                        `/api/marketing-campaigns/${campaign.id}/memberships`,
                        "POST",
                        { ...payload, requestKey: command.keyFor(payload) },
                      ),
                    "Recipient enrolled. Open their sequence and choose Start sequence to authorize scheduled delivery.",
                  )
                  .then((value) => {
                    if (value) {
                      command.reset();
                      setReason("");
                      members.reload();
                    }
                  });
              }}
            >
              <fieldset disabled={action.busy} className="space-y-4">
                <EmailField label="Enrollment reason">
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
                <label className="flex min-h-11 items-center gap-3">
                  <input
                    type="checkbox"
                    className="checkbox"
                    checked={newCycle}
                    onChange={(e) => setNewCycle(e.target.checked)}
                  />
                  Start a new cycle after an earlier sequence has ended
                </label>
                <p className="text-sm">
                  Enrollment requires category consent, enabled enrollment and a
                  ready sender. It does not start scheduled work.
                </p>
                <button
                  disabled={!recipient}
                  className="btn btn-primary min-h-11 normal-case"
                >
                  Enroll recipient
                </button>
              </fieldset>
            </form>
          </div>
        </details>
      ) : (
        <p>Publish a version before enrolling recipients.</p>
      )}
      <div className="mt-5 space-y-3">
        {members.data?.memberships.map((m) => (
          <article
            key={m.id}
            className="rounded-box border border-base-300 p-4"
          >
            <Link
              href={`/email/memberships/${m.id}`}
              className="link font-semibold"
            >
              {m.scopeKind === "SUBJECT"
                ? `Journey ${shortId(m.subjectId!)}`
                : `Contact ${shortId(m.contactId)}`}{" "}
              · Cycle {m.cycle}
            </Link>
            <p className="mt-2">
              {m.status} · Enrolled {dateLabel(m.startedAt)}
              {m.stopReason ? ` · ${m.stopReason.replaceAll("_", " ")}` : ""}
            </p>
          </article>
        ))}
        {members.data?.memberships.length === 0 ? (
          <p>No recipients enrolled yet.</p>
        ) : null}
        {members.data?.nextCursor ? (
          <button
            type="button"
            className={buttonClass}
            onClick={() => setCursor(members.data!.nextCursor!)}
          >
            Next sequences
          </button>
        ) : null}
        {cursor ? (
          <button
            type="button"
            className={buttonClass}
            onClick={() => setCursor(undefined)}
          >
            First sequences
          </button>
        ) : null}
      </div>
    </EmailPanel>
  );
}
