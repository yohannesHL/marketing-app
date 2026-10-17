"use client";
import { useState } from "react";
import type { CampaignDefinition } from "../../server/email/campaignDefinition";
import {
  EmailFeedback,
  EmailField,
  EmailPanel,
  inputClass,
  selectClass,
  buttonClass,
} from "./EmailLayout";
import { ExactDateField } from "./EmailStepEditor";
import {
  dateLabel,
  emailRequest,
  newKey,
  useEmailAction,
  type EmailSource,
} from "./emailUi";
type Sample = {
  id: string;
  sourceId: string;
  type: string;
  occurredAt: string;
  availableAt: string;
  mode: "LIVE" | "BACKFILL" | "REPLAY";
  sameSubject: boolean;
  sourceCurrent: boolean;
  properties: { key: string; type: string; value: string }[];
};
type Result = {
  simulated: true;
  externalEffects: false;
  note: string;
  history: {
    stepId: string;
    status: string;
    reason: string;
    dueAt?: string;
    expiresAt?: string;
    nextWakeAt?: string;
    completedAt?: string;
  }[];
};
export function EmailCampaignSimulator({
  campaignId,
  definition,
  sources,
}: {
  campaignId: string;
  definition: CampaignDefinition;
  sources: EmailSource[];
}) {
  const action = useEmailAction(),
    [enrolledAt, setEnrolledAt] = useState(() => new Date().toISOString()),
    [now, setNow] = useState(() => new Date().toISOString()),
    [flags, setFlags] = useState({
      consent: false,
      senderReady: false,
      dispatchEnabled: false,
      stopped: false,
      waitSourceCurrent: true,
    }),
    [samples, setSamples] = useState<Sample[]>([]),
    [accepted, setAccepted] = useState<Record<string, string>>({}),
    [result, setResult] = useState<Result>();
  const update = (id: string, patch: Partial<Sample>) =>
    setSamples((values) =>
      values.map((v) => (v.id === id ? { ...v, ...patch } : v)),
    );
  async function simulate() {
    const duplicates = samples.some(
      (sample) =>
        new Set(sample.properties.map((p) => p.key)).size !==
        sample.properties.length,
    );
    if (duplicates) {
      action.setError(new Error("Use each sample property once per event."));
      return;
    }
    if (
      samples.some((sample) =>
        sample.properties.some(
          (p) =>
            p.type === "number" &&
            (!p.value.trim() || !Number.isFinite(Number(p.value))),
        ),
      )
    ) {
      action.setError(
        new Error("Enter a finite numeric value for each number sample."),
      );
      return;
    }
    const events = samples.map(({ id: _, properties, ...sample }) => ({
      ...sample,
      properties: Object.fromEntries(
        properties.map((p) => [
          p.key,
          p.type === "number"
            ? Number(p.value)
            : p.type === "boolean"
              ? p.value === "true"
              : p.type === "null"
                ? null
                : p.value,
        ]),
      ),
    }));
    const value = await action.run(() =>
      emailRequest<Result>(
        `/api/marketing-campaigns/${campaignId}/simulate`,
        "POST",
        {
          definition,
          enrolledAt,
          now,
          eligibility: flags,
          events,
          acceptedAtByStep: accepted,
        },
      ),
    );
    if (value) setResult(value);
  }
  return (
    <EmailPanel title="Test this sequence without sending">
      <p className="mb-5">
        This preview uses only the sample times, events and eligibility you
        supply. It does not check a live provider, enroll anyone or send a
        message.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void simulate();
        }}
      >
        <fieldset disabled={action.busy} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <ExactDateField
              label="Sample enrollment time"
              value={enrolledAt}
              zone={definition.timeZone}
              onChange={setEnrolledAt}
            />
            <ExactDateField
              label="Preview clock"
              value={now}
              zone={definition.timeZone}
              onChange={setNow}
            />
          </div>
          <fieldset>
            <legend className="mb-2 font-semibold">Sample eligibility</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  ["consent", "Recipient has consent"],
                  ["senderReady", "Sender is ready"],
                  ["dispatchEnabled", "Campaign sending is enabled"],
                  ["stopped", "Sequence has been stopped"],
                  ["waitSourceCurrent", "Event source is current"],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="flex min-h-11 items-center gap-3">
                  <input
                    className="checkbox"
                    type="checkbox"
                    checked={flags[key]}
                    onChange={(e) =>
                      setFlags({ ...flags, [key]: e.target.checked })
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          <details>
            <summary className="cursor-pointer py-3 font-semibold">
              Sample events ({samples.length})
            </summary>
            <div className="space-y-4">
              {samples.map((sample) => {
                const source = sources.find((s) => s.id === sample.sourceId);
                return (
                  <fieldset
                    key={sample.id}
                    className="space-y-4 rounded-box border border-base-300 p-4"
                  >
                    <legend className="font-medium">
                      Event sample {samples.indexOf(sample) + 1}
                    </legend>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <EmailField label="Sample source">
                        {(id) => (
                          <select
                            id={id}
                            required
                            className={selectClass}
                            value={sample.sourceId}
                            onChange={(e) => {
                              const s = sources.find(
                                (v) => v.id === e.target.value,
                              );
                              update(sample.id, {
                                sourceId: e.target.value,
                                type: s?.config.allowedEvents[0] || "",
                                properties: [],
                              });
                            }}
                          >
                            <option value="">Choose a source</option>
                            {sources.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name}
                              </option>
                            ))}
                          </select>
                        )}
                      </EmailField>
                      <EmailField label="Sample event">
                        {(id) => (
                          <select
                            id={id}
                            required
                            className={selectClass}
                            value={sample.type}
                            onChange={(e) =>
                              update(sample.id, { type: e.target.value })
                            }
                          >
                            {source?.config.allowedEvents.map((t) => (
                              <option key={t}>{t}</option>
                            ))}
                          </select>
                        )}
                      </EmailField>
                      <ExactDateField
                        label="Event happened at"
                        value={sample.occurredAt}
                        zone={definition.timeZone}
                        onChange={(occurredAt) =>
                          update(sample.id, { occurredAt })
                        }
                      />
                      <ExactDateField
                        label="Evidence available at"
                        value={sample.availableAt}
                        zone={definition.timeZone}
                        onChange={(availableAt) =>
                          update(sample.id, { availableAt })
                        }
                      />
                    </div>
                    <EmailField label="Evidence origin">
                      {(id) => (
                        <select
                          id={id}
                          className={selectClass}
                          value={sample.mode}
                          onChange={(e) =>
                            update(sample.id, {
                              mode: e.target.value as Sample["mode"],
                            })
                          }
                        >
                          <option value="LIVE">Original verified event</option>
                          <option value="BACKFILL">Historical import</option>
                          <option value="REPLAY">Replayed event</option>
                        </select>
                      )}
                    </EmailField>
                    <div className="flex flex-wrap gap-4">
                      <label className="flex min-h-11 items-center gap-2">
                        <input
                          type="checkbox"
                          checked={sample.sameSubject}
                          onChange={(e) =>
                            update(sample.id, { sameSubject: e.target.checked })
                          }
                        />
                        Same business journey
                      </label>
                      <label className="flex min-h-11 items-center gap-2">
                        <input
                          type="checkbox"
                          checked={sample.sourceCurrent}
                          onChange={(e) =>
                            update(sample.id, {
                              sourceCurrent: e.target.checked,
                            })
                          }
                        />
                        Current source configuration
                      </label>
                    </div>
                    {sample.properties.map((property, index) => (
                      <div key={index} className="grid gap-3 sm:grid-cols-3">
                        <EmailField label="Property">
                          {(id) => (
                            <select
                              id={id}
                              required
                              className={selectClass}
                              value={property.key}
                              onChange={(e) =>
                                update(sample.id, {
                                  properties: sample.properties.map((p, i) =>
                                    i === index
                                      ? { ...p, key: e.target.value }
                                      : p,
                                  ),
                                })
                              }
                            >
                              <option value="">Choose field</option>
                              {source?.config.propertyKeys.map((key) => (
                                <option key={key}>{key}</option>
                              ))}
                            </select>
                          )}
                        </EmailField>
                        <EmailField label="Value type">
                          {(id) => (
                            <select
                              id={id}
                              className={selectClass}
                              value={property.type}
                              onChange={(e) =>
                                update(sample.id, {
                                  properties: sample.properties.map((p, i) =>
                                    i === index
                                      ? {
                                          ...p,
                                          type: e.target.value,
                                          value:
                                            e.target.value === "boolean"
                                              ? "true"
                                              : "",
                                        }
                                      : p,
                                  ),
                                })
                              }
                            >
                              {["string", "number", "boolean", "null"].map(
                                (type) => (
                                  <option key={type}>{type}</option>
                                ),
                              )}
                            </select>
                          )}
                        </EmailField>
                        <EmailField label="Sample value">
                          {(id) =>
                            property.type === "boolean" ? (
                              <select
                                id={id}
                                className={selectClass}
                                value={property.value}
                                onChange={(e) =>
                                  update(sample.id, {
                                    properties: sample.properties.map((p, i) =>
                                      i === index
                                        ? { ...p, value: e.target.value }
                                        : p,
                                    ),
                                  })
                                }
                              >
                                <option>true</option>
                                <option>false</option>
                              </select>
                            ) : (
                              <input
                                id={id}
                                disabled={property.type === "null"}
                                type={
                                  property.type === "number" ? "number" : "text"
                                }
                                step="any"
                                className={inputClass}
                                value={property.value}
                                onChange={(e) =>
                                  update(sample.id, {
                                    properties: sample.properties.map((p, i) =>
                                      i === index
                                        ? { ...p, value: e.target.value }
                                        : p,
                                    ),
                                  })
                                }
                              />
                            )
                          }
                        </EmailField>
                      </div>
                    ))}
                    <div className="flex flex-wrap gap-3">
                      <button
                        type="button"
                        className={buttonClass}
                        onClick={() =>
                          update(sample.id, {
                            properties: [
                              ...sample.properties,
                              { key: "", type: "string", value: "" },
                            ],
                          })
                        }
                      >
                        Add sample property
                      </button>
                      <button
                        type="button"
                        className={buttonClass}
                        onClick={() =>
                          setSamples((v) => v.filter((s) => s.id !== sample.id))
                        }
                      >
                        Remove event sample
                      </button>
                    </div>
                  </fieldset>
                );
              })}
              <button
                type="button"
                className={buttonClass}
                disabled={samples.length >= 100}
                onClick={() =>
                  setSamples((v) => [
                    ...v,
                    {
                      id: newKey(),
                      sourceId: sources[0]?.id || "",
                      type: sources[0]?.config.allowedEvents[0] || "",
                      occurredAt: now,
                      availableAt: now,
                      mode: "LIVE",
                      sameSubject: true,
                      sourceCurrent: true,
                      properties: [],
                    },
                  ])
                }
              >
                Add sample event
              </button>
            </div>
          </details>
          <details>
            <summary className="cursor-pointer py-3 font-semibold">
              Supply sample acceptances to preview later steps
            </summary>
            <p className="mb-3 text-sm">
              A READY message waits here until you supply acceptance. These
              samples are hypothetical and do not claim that a message was sent.
            </p>
            <div className="space-y-3">
              {definition.steps.map((step, index) => (
                <div key={step.id}>
                  <label className="flex min-h-11 items-center gap-3">
                    <input
                      type="checkbox"
                      checked={!!accepted[step.id]}
                      onChange={(e) =>
                        setAccepted((v) => {
                          const next = { ...v };
                          if (e.target.checked) next[step.id] = now;
                          else delete next[step.id];
                          return next;
                        })
                      }
                    />
                    Sample acceptance for message {index + 1}:{" "}
                    {step.subject || "Untitled"}
                  </label>
                  {accepted[step.id] ? (
                    <ExactDateField
                      label={`Message ${index + 1} accepted at`}
                      value={accepted[step.id]}
                      zone={definition.timeZone}
                      onChange={(at) =>
                        setAccepted((v) => ({ ...v, [step.id]: at }))
                      }
                    />
                  ) : null}
                </div>
              ))}
            </div>
          </details>
          <button className="btn btn-primary min-h-11 normal-case">
            Run no-send simulation
          </button>
        </fieldset>
      </form>
      <div className="mt-5">
        <EmailFeedback {...action} />
      </div>
      {result ? (
        <ol aria-label="Simulated sequence history" className="mt-5 space-y-3">
          {result.history.map((row, index) => (
            <li
              key={`${row.stepId}:${index}`}
              className="rounded-box bg-base-200 p-4"
            >
              <h3 className="font-semibold">
                Message{" "}
                {definition.steps.findIndex((s) => s.id === row.stepId) + 1} ·{" "}
                {row.status}
              </h3>
              <p className="mt-2">
                {row.reason.replaceAll("_", " ").toLowerCase()}
              </p>
              <p className="mt-2 text-sm">
                Due {dateLabel(row.dueAt)} · Next action{" "}
                {dateLabel(row.nextWakeAt || row.completedAt)} · Expires{" "}
                {dateLabel(row.expiresAt)}
              </p>
            </li>
          ))}
        </ol>
      ) : null}
    </EmailPanel>
  );
}
