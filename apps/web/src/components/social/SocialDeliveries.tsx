"use client";
import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Stack,
  Typography,
} from "@launchpad/ui";
import {
  SocialSchedule,
  futureLocalTime,
  initialTimeZone,
} from "./SocialSchedule";
import { publicationTime, scheduleInstants, utcTime } from "./socialTime";
import {
  deliveryLabel,
  safePublishUrl,
  socialRequest,
  socialErrorHelp,
  type SocialPost,
} from "./socialUi";
export function SocialDeliveries({
  post,
  busy,
  onAction,
  onUpdate,
}: {
  post: SocialPost;
  busy: boolean;
  onAction: (work: () => Promise<void>) => Promise<void>;
  onUpdate: (post: SocialPost) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]),
    [confirmCancel, setConfirmCancel] = useState(false),
    [rescheduling, setRescheduling] = useState(false),
    [zone, setZone] = useState(initialTimeZone),
    [localTime, setLocalTime] = useState(() =>
      futureLocalTime(initialTimeZone()),
    ),
    [chosen, setChosen] = useState("");
  const rows = post.deliveries.filter((d) => selected.includes(d.id)),
    canCancel =
      rows.length > 0 &&
      rows.every(
        (d) => !["SUCCEEDED", "CANCELLED", "SUPERSEDED"].includes(d.status) && d.errorCode !== "PROVIDER_PROCESSING_FAILED",
      ),
    canReschedule =
      rows.length > 0 &&
      rows.every(
        (d) =>
          ["QUEUED", "RETRY_WAIT", "BLOCKED"].includes(d.status) &&
          d.phase !== "PUBLISH",
      ),
    canRetry =
      rows.length > 0 &&
      rows.every(
        (d) =>
          ["FAILED", "BLOCKED", "RETRY_WAIT"].includes(d.status) &&
          d.phase !== "PUBLISH" &&
          d.errorCode !== "PROVIDER_PROCESSING_FAILED" &&
          !d.cancellationRequested &&
          d.revisionId === post.revision.id,
      );
  const instants = scheduleInstants(localTime, zone),
    dueAt =
      instants.length === 1
        ? instants[0]
        : instants.includes(chosen)
          ? chosen
          : "";
  async function update(action: string, extra: Record<string, unknown> = {}) {
    await onAction(async () => {
      onUpdate(
        await socialRequest<SocialPost>(
          `/api/social/posts/${encodeURIComponent(post.id)}/${action}`,
          "POST",
          { deliveryIds: selected, ...extra },
        ),
      );
      setSelected([]);
      setConfirmCancel(false);
      setRescheduling(false);
    });
  }
  return (
    <Card>
      <Stack gap={4}>
        <Typography as="h2" variant="heading-2">
          Delivery details
        </Typography>
        <Typography tone="muted">
          Each destination has its own result. Published deliveries are retained
          when another destination fails. Only explicitly selected safe failures
          can be retried.
        </Typography>
        {post.deliveries.map((d) => {
          const name =
              post.revision.variants.find(
                (v) => v.destinationId === d.destinationId,
              )?.name ?? "Social destination",
            url = safePublishUrl(d.publishUrl);
          return (
            <section
              key={d.id}
              className="rounded-box border border-base-300 p-4"
            >
              <Stack gap={2}>
                <Checkbox
                  label={`Select delivery for ${name} (${d.id.slice(-8)})`}
                  checked={selected.includes(d.id)}
                  disabled={
                    busy ||
                    d.errorCode === "PROVIDER_PROCESSING_FAILED" ||
                    ["SUCCEEDED", "CANCELLED", "SUPERSEDED"].includes(d.status)
                  }
                  onChange={(e) => {
                    setSelected(
                      e.target.checked
                        ? [...selected, d.id]
                        : selected.filter((id) => id !== d.id),
                    );
                    setConfirmCancel(false);
                  }}
                />
                <Typography variant="caption" tone="muted">
                  {d.revisionId === post.revision.id
                    ? `Current revision ${post.revision.number}`
                    : "Earlier revision"}{" "}
                  · Delivery {d.id.slice(-8)}
                </Typography>
                <div className="flex flex-wrap gap-2">
                  <Badge
                    tone={
                      d.status === "SUCCEEDED"
                        ? "success"
                        : d.status === "UNCERTAIN" || d.status === "FAILED"
                          ? "warning"
                          : "neutral"
                    }
                  >
                    {deliveryLabel(d.status)}
                  </Badge>
                  <Typography variant="caption">
                    Stage:{" "}
                    {(
                      {
                        PREPARE: "Preparing",
                        UPLOAD: "Uploading",
                        PROCESS: "Provider processing",
                        PUBLISH: "Publishing",
                        COMPLETE: "Complete",
                      } as Record<string, string>
                    )[d.phase] ?? "Checking"}
                  </Typography>
                </div>
                <Typography variant="caption">
                  {publicationTime(d.dueAt, d.timeZone)} · {d.timeZone}
                </Typography>
                <Typography variant="caption" tone="muted">
                  {utcTime(d.dueAt)} · Attempts: {d.attempts}
                </Typography>
                {d.externalId ? (
                  <Typography variant="caption" className="break-all">
                    Provider reference: {d.externalId}
                  </Typography>
                ) : null}
                {url ? (
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="link link-primary min-h-11 inline-flex items-center"
                  >
                    Open published post
                  </a>
                ) : null}
                {d.status === "UNCERTAIN" ? (
                  <Alert title="Provider outcome needs checking" tone="warning">
                    A publish request may have reached the provider. Retry is
                    blocked to prevent duplicate posts. Refresh for
                    reconciliation updates; cancellation cannot undo a published
                    post.
                  </Alert>
                ) : null}
                {d.cancellationRequested ? (
                  <Typography variant="caption">
                    Cancellation requested. An in-flight publication may still
                    complete.
                  </Typography>
                ) : null}
                {d.errorCode && d.status !== "UNCERTAIN" ? (
                  <Typography variant="caption">
                    {d.errorCode === "PROVIDER_PROCESSING_FAILED" ? "The provider confirmed processing failed. Its receipt is retained and this delivery cannot be sent again. Review the content before creating another post." : socialErrorHelp(d.errorCode)}
                  </Typography>
                ) : null}
              </Stack>
            </section>
          );
        })}
        <div className="flex flex-wrap gap-3">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() =>
              void onAction(async () =>
                onUpdate(
                  await socialRequest<SocialPost>(
                    `/api/social/posts/${encodeURIComponent(post.id)}`,
                  ),
                ),
              )
            }
          >
            Refresh delivery status
          </Button>
          <Button
            variant="secondary"
            disabled={busy || !canReschedule}
            onClick={() => setRescheduling(!rescheduling)}
          >
            Reschedule selected
          </Button>
          <Button
            variant="secondary"
            disabled={busy || !canRetry}
            onClick={() => void update("retry")}
          >
            Retry selected safe failures
          </Button>
          <Button
            variant="destructive"
            disabled={busy || !canCancel}
            onClick={() => setConfirmCancel(true)}
          >
            Cancel selected deliveries
          </Button>
        </div>
        {confirmCancel ? (
          <Alert title="Confirm cancellation" tone="warning">
            <Stack gap={3}>
              <Typography>
                Stop {rows.length} selected{" "}
                {rows.length === 1 ? "delivery" : "deliveries"}? This cannot
                remove posts already published. An in-flight result may need
                checking.
              </Typography>
              <div className="flex flex-wrap gap-3">
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() => void update("cancel")}
                >
                  Confirm cancellation
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setConfirmCancel(false)}
                >
                  Keep deliveries
                </Button>
              </div>
            </Stack>
          </Alert>
        ) : null}
        {rescheduling ? (
          <Stack gap={3}>
            <SocialSchedule
              zone={zone}
              localTime={localTime}
              chosen={chosen}
              onZone={setZone}
              onTime={setLocalTime}
              onChosen={setChosen}
              disabled={busy}
            />
            <Button
              disabled={
                busy ||
                !canReschedule ||
                !dueAt ||
                Date.parse(dueAt) <= Date.now() ||
                Date.parse(dueAt) > Date.now() + 366 * 86400000
              }
              onClick={() =>
                void update("reschedule", { dueAt, timeZone: zone })
              }
            >
              Confirm new delivery time
            </Button>
          </Stack>
        ) : null}
      </Stack>
    </Card>
  );
}
