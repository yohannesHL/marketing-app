"use client";
import { useState, useEffect } from "react";
import Link from "next/link";
import type {
  CampaignDefinition,
  CampaignWait,
} from "../../server/email/campaignDefinition";
import { resolveLocal } from "../../server/email/emailTiming";
import { ConditionEditor } from "../funnels/ConditionEditor";
import {
  EmailField,
  inputClass,
  selectClass,
  buttonClass,
} from "./EmailLayout";
import type { EmailSource } from "./emailUi";
type Step = CampaignDefinition["steps"][number];
export function DurationField({
  label,
  seconds,
  onChange,
}: {
  label: string;
  seconds: number;
  onChange: (seconds: number) => void;
}) {
  const initial =
    seconds % 86400 === 0
      ? 86400
      : seconds % 3600 === 0
        ? 3600
        : seconds % 60 === 0
          ? 60
          : 1;
  const [unit, setUnit] = useState(initial);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(6rem,0.6fr)] items-end gap-3">
      <EmailField label={label}>
        {(id) => (
          <input
            id={id}
            type="number"
            min={1 / unit}
            max={31536000 / unit}
            step="any"
            required
            className={inputClass}
            value={Number.isFinite(seconds) ? seconds / unit : ""}
            onChange={(e) =>
              onChange(
                e.target.value === "" ? NaN : Number(e.target.value) * unit,
              )
            }
          />
        )}
      </EmailField>
      <EmailField label={`${label} unit`}>
        {(id) => (
          <select
            id={id}
            className={selectClass}
            value={unit}
            onChange={(e) => setUnit(Number(e.target.value))}
          >
            <option value={86400}>Days</option>
            <option value={3600}>Hours</option>
            <option value={60}>Minutes</option>
            <option value={1}>Seconds</option>
          </select>
        )}
      </EmailField>
    </div>
  );
}
function localValue(at: string, zone: string) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(at));
    const p = Object.fromEntries(parts.map((v) => [v.type, v.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  } catch {
    return "";
  }
}
export function ExactDateField({
  label,
  value,
  zone,
  onChange,
  onValidityChange,
}: {
  label: string;
  value: string;
  zone: string;
  onChange: (value: string) => void;
  onValidityChange?: (valid: boolean) => void;
}) {
  const [local, setLocal] = useState(() => localValue(value, zone)),
    [error, setError] = useState(""),
    [note, setNote] = useState("");
  useEffect(() => {
    setLocal(localValue(value, zone));
  }, [zone, value]);
  return (
    <EmailField label={label} hint={`Timezone: ${zone}. ${note}`}>
      {(id) => (
        <>
          <input
            id={id}
            type="datetime-local"
            className={inputClass}
            required
            value={local}
            aria-invalid={!!error}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(e) => {
              setLocal(e.target.value);
              try {
                const resolved = resolveLocal(e.target.value, zone);
                setError("");
                setNote(
                  resolved.resolution === "AMBIGUOUS_LATER"
                    ? "This repeated time uses the later occurrence."
                    : resolved.resolution === "GAP_FIRST_VALID"
                      ? "This skipped local time moves to the first valid instant."
                      : "",
                );
                onValidityChange?.(true);
                onChange(resolved.instant);
              } catch {
                setError("Choose a valid date, time and named timezone.");
                onValidityChange?.(false);
              }
            }}
          />
          {error ? (
            <p id={`${id}-error`} className="mt-2 text-error">
              {error}
            </p>
          ) : null}
        </>
      )}
    </EmailField>
  );
}
export function EmailStepEditor({
  step,
  onChange,
  sources,
  timeZone,
  subjectScope,
  onValidityChange,
}: {
  step: Step;
  onChange: (step: Step) => void;
  sources: EmailSource[];
  timeZone: string;
  subjectScope: boolean;
  onValidityChange: (valid: boolean) => void;
}) {
  const [advanced, setAdvanced] = useState(!!step.html),
    [dateValid, setDateValid] = useState(true),
    [conditionValid, setConditionValid] = useState(true);
  useEffect(() => {
    onValidityChange(dateValid && conditionValid);
  }, [dateValid, conditionValid, onValidityChange]);
  const update = (patch: Partial<Step>) => onChange({ ...step, ...patch }),
    wait = step.wait,
    source =
      wait.kind === "EVENT"
        ? sources.find((s) => s.id === wait.sourceId)
        : undefined;
  function setWait(kind: string) {
    setDateValid(true);
    setConditionValid(true);
    let next: CampaignWait = { kind: "IMMEDIATE" };
    if (kind === "DURATION") next = { kind: "DURATION", seconds: 86400 };
    if (kind === "DATE")
      next = {
        kind: "DATE",
        at: new Date(Date.now() + 86400000).toISOString(),
      };
    if (kind === "EVENT")
      next = {
        kind: "EVENT",
        sourceId: sources[0]?.id || "",
        type: sources[0]?.config.allowedEvents[0] || "",
        anchor: "WAIT_STARTED",
        timeoutSeconds: 604800,
        onTimeout: "SKIP_STEP",
      };
    update({ wait: next });
  }
  return (
    <div className="space-y-5">
      <EmailField label="Email subject">
        {(id) => (
          <input
            id={id}
            required
            maxLength={300}
            className={inputClass}
            value={step.subject}
            onChange={(e) => update({ subject: e.target.value })}
          />
        )}
      </EmailField>
      <EmailField
        label="Message"
        hint="A visible unsubscribe link is appended automatically. Personalization placeholders are not supported."
      >
        {(id) => (
          <textarea
            id={id}
            rows={8}
            required={!step.html}
            maxLength={65536}
            className="textarea textarea-bordered min-h-44 w-full bg-base-100 text-base"
            value={step.text || ""}
            onChange={(e) => update({ text: e.target.value || undefined })}
          />
        )}
      </EmailField>
      <button
        type="button"
        className={buttonClass}
        onClick={() => setAdvanced((v) => !v)}
        aria-expanded={advanced}
      >
        {advanced ? "Hide HTML editor" : "Add optional HTML content"}
      </button>
      {advanced ? (
        <EmailField
          label="HTML message (optional)"
          hint="This is email content. It is not executed or previewed in your workspace."
        >
          {(id) => (
            <textarea
              id={id}
              rows={7}
              maxLength={65536}
              className="textarea textarea-bordered w-full bg-base-100 font-mono"
              value={step.html || ""}
              onChange={(e) => update({ html: e.target.value || undefined })}
            />
          )}
        </EmailField>
      ) : null}
      <div className="border-t border-base-300 pt-5">
        <EmailField label="When should this message become due?">
          {(id) => (
            <select
              id={id}
              value={wait.kind}
              className={selectClass}
              onChange={(e) => setWait(e.target.value)}
            >
              <option value="IMMEDIATE">
                Immediately after the previous step
              </option>
              <option value="DURATION">After a delay</option>
              <option value="DATE">On a specific date</option>
              <option value="EVENT" disabled={!subjectScope}>
                After a verified event
                {subjectScope ? "" : " · requires separate business journeys"}
              </option>
            </select>
          )}
        </EmailField>
      </div>
      {wait.kind === "DURATION" ? (
        <DurationField
          label="Delay"
          seconds={wait.seconds}
          onChange={(seconds) => update({ wait: { ...wait, seconds } })}
        />
      ) : null}
      {wait.kind === "DATE" ? (
        <ExactDateField
          label="Due date and time"
          value={wait.at}
          zone={timeZone}
          onChange={(at) => update({ wait: { ...wait, at } })}
          onValidityChange={setDateValid}
        />
      ) : null}
      {wait.kind === "EVENT" ? (
        <div className="space-y-4 rounded-box bg-base-200 p-4">
          <EmailField label="Event source">
            {(id) => (
              <select
                id={id}
                required
                className={selectClass}
                value={wait.sourceId}
                onChange={(e) => {
                  const selected = sources.find((s) => s.id === e.target.value);
                  update({
                    wait: {
                      ...wait,
                      sourceId: e.target.value,
                      type: selected?.config.allowedEvents[0] || "",
                      condition: undefined,
                    },
                  });
                }}
              >
                <option value="">Choose an active source</option>
                {wait.sourceId && !source ? (
                  <option value={wait.sourceId}>
                    Unavailable source · {wait.sourceId.slice(0, 8)}
                  </option>
                ) : null}
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.provider}
                  </option>
                ))}
              </select>
            )}
          </EmailField>
          <EmailField label="Event to wait for">
            {(id) => (
              <select
                id={id}
                required
                className={selectClass}
                value={wait.type}
                onChange={(e) =>
                  update({ wait: { ...wait, type: e.target.value } })
                }
              >
                <option value="">Choose an event</option>
                {wait.type &&
                !source?.config.allowedEvents.includes(wait.type) ? (
                  <option value={wait.type}>{wait.type} · unavailable</option>
                ) : null}
                {source?.config.allowedEvents.map((event) => (
                  <option key={event}>{event}</option>
                ))}
              </select>
            )}
          </EmailField>
          {!source ? (
            <p>
              Choose an active source or check its setup in{" "}
              <Link className="link" href="/tracking">
                Tracking sources
              </Link>
              . Publication checks this source again.
            </p>
          ) : null}
          <EmailField label="Count matching events from">
            {(id) => (
              <select
                id={id}
                value={wait.anchor}
                className={selectClass}
                onChange={(e) =>
                  update({
                    wait: {
                      ...wait,
                      anchor: e.target.value as "ENROLLED" | "WAIT_STARTED",
                    },
                  })
                }
              >
                <option value="WAIT_STARTED">
                  When this step starts waiting
                </option>
                <option value="ENROLLED">When the recipient enrolled</option>
              </select>
            )}
          </EmailField>
          <DurationField
            label="Maximum event wait"
            seconds={wait.timeoutSeconds}
            onChange={(timeoutSeconds) =>
              update({ wait: { ...wait, timeoutSeconds } })
            }
          />
          <EmailField label="If no event arrives in time">
            {(id) => (
              <select
                id={id}
                value={wait.onTimeout}
                className={selectClass}
                onChange={(e) =>
                  update({
                    wait: {
                      ...wait,
                      onTimeout: e.target.value as
                        | "SKIP_STEP"
                        | "STOP_MEMBERSHIP",
                    },
                  })
                }
              >
                <option value="SKIP_STEP">
                  Skip this message and continue
                </option>
                <option value="STOP_MEMBERSHIP">
                  Stop this recipient’s sequence
                </option>
              </select>
            )}
          </EmailField>
          <ConditionEditor
            value={wait.condition}
            onChange={(condition) => update({ wait: { ...wait, condition } })}
            fields={source?.config.propertyKeys || []}
            scope="EVENT"
            label="Optional event conditions"
            onValidityChange={setConditionValid}
          />
          <p className="text-sm">
            Only verified events for this same business journey can release the
            wait. Replayed or historical imports cannot release it. The timeout
            starts when this step begins waiting.
          </p>
        </div>
      ) : null}
      <DurationField
        label="Expire unsent message after due time"
        seconds={step.expiresAfterDueSeconds}
        onChange={(expiresAfterDueSeconds) =>
          update({ expiresAfterDueSeconds })
        }
      />
      <p className="text-sm text-base-content/75">
        Sending still respects the campaign window, consent and current journey
        state. An uncertain provider response holds the sequence for
        reconciliation.
      </p>
    </div>
  );
}
export function EmailSendWindowEditor({
  definition,
  onChange,
}: {
  definition: CampaignDefinition;
  onChange: (d: CampaignDefinition) => void;
}) {
  const window = definition.sendWindow,
    allDay = window.startMinute === 0 && window.endMinute === 1440;
  const time = (minutes: number) =>
    `${String(Math.floor((minutes % 1440) / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  const change = (patch: Partial<typeof window>) =>
    onChange({ ...definition, sendWindow: { ...window, ...patch } });
  return (
    <div className="space-y-4">
      <EmailField
        label="Campaign timezone"
        hint="Use an IANA name such as Europe/London or America/New_York. Default: UTC."
      >
        {(id) => (
          <input
            id={id}
            required
            className={inputClass}
            list="email-timezones"
            value={definition.timeZone}
            onChange={(e) =>
              onChange({
                ...definition,
                timeZone: e.target.value,
                sendWindow: { ...window, timeZone: e.target.value },
              })
            }
          />
        )}
      </EmailField>
      <datalist id="email-timezones">
        {[
          "UTC",
          "Europe/London",
          "Europe/Paris",
          "America/New_York",
          "America/Chicago",
          "America/Los_Angeles",
          "Asia/Dubai",
          "Asia/Kolkata",
          "Asia/Singapore",
          "Australia/Sydney",
        ].map((zone) => (
          <option key={zone} value={zone} />
        ))}
      </datalist>
      <fieldset>
        <legend className="mb-2 font-medium">Allowed weekdays</legend>
        <div className="flex flex-wrap gap-2">
          {[
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
            "Sunday",
          ].map((day, index) => (
            <label
              key={day}
              className="flex min-h-11 items-center gap-2 rounded-box border border-base-300 px-3"
            >
              <input
                type="checkbox"
                className="checkbox checkbox-sm"
                checked={window.weekdays.includes(index + 1)}
                onChange={(e) =>
                  change({
                    weekdays: e.target.checked
                      ? [...window.weekdays, index + 1]
                      : window.weekdays.filter((d) => d !== index + 1),
                  })
                }
              />
              {day}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex min-h-11 items-center gap-3">
        <input
          type="checkbox"
          className="checkbox"
          checked={allDay}
          onChange={(e) =>
            change(
              e.target.checked
                ? { startMinute: 0, endMinute: 1440 }
                : { startMinute: 540, endMinute: 1020 },
            )
          }
        />
        All day on selected weekdays
      </label>
      {!allDay ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <EmailField label="Sending starts">
            {(id) => (
              <input
                id={id}
                required
                type="time"
                className={inputClass}
                value={time(window.startMinute)}
                onChange={(e) => {
                  const [h, m] = e.target.value.split(":").map(Number);
                  change({ startMinute: h * 60 + m });
                }}
              />
            )}
          </EmailField>
          <EmailField
            label="Sending ends"
            hint="00:00 means the end of the day."
          >
            {(id) => (
              <input
                id={id}
                required
                type="time"
                className={inputClass}
                value={time(window.endMinute)}
                onChange={(e) => {
                  const [h, m] = e.target.value.split(":").map(Number);
                  change({ endMinute: h * 60 + m || 1440 });
                }}
              />
            )}
          </EmailField>
        </div>
      ) : null}
      <p className="text-sm">
        The window controls submission, not arrival time. Pausing does not
        restart delays or expiry clocks.
      </p>
    </div>
  );
}
