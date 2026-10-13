"use client";
import { useRef, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Select,
  Stack,
  Typography,
} from "@launchpad/ui";
import { MediaPreview } from "./MediaPreview";
import { ReviewedOptions } from "./ProviderControls";
import {
  SocialSchedule,
  futureLocalTime,
  initialTimeZone,
} from "./SocialSchedule";
import { publicationTime, scheduleInstants, utcTime } from "./socialTime";
import { socialLabel, socialRequest, type SocialPost } from "./socialUi";
export function SocialReview({
  post,
  busy,
  onAction,
  onUpdate,
  onNotice,
}: {
  post: SocialPost;
  busy: boolean;
  onAction: (work: () => Promise<void>) => Promise<void>;
  onUpdate: (post: SocialPost) => void;
  onNotice: (notice: string) => void;
}) {
  const [reviewed, setReviewed] = useState(false),
    [timing, setTiming] = useState("now"),
    [zone, setZone] = useState(initialTimeZone),
    [localTime, setLocalTime] = useState(() =>
      futureLocalTime(initialTimeZone()),
    ),
    [chosen, setChosen] = useState("");
  const submit = useRef<{
    digest: string;
    enqueueId: string;
    dueAt: string;
  } | null>(null);
  const ids = post.revision.variants.map((v) => v.destinationId),
    approved = Boolean(
      post.revision.reviewedAt &&
        post.revision.approvedDestinations?.length === ids.length &&
        ids.every((id) => post.revision.approvedDestinations?.includes(id)),
    );
  const instants = scheduleInstants(localTime, zone),
    scheduled =
      instants.length === 1
        ? instants[0]
        : instants.includes(chosen)
          ? chosen
          : "",
    validFuture = Boolean(
      scheduled &&
        Date.parse(scheduled) > Date.now() &&
        Date.parse(scheduled) <= Date.now() + 366 * 86400000,
    );
  const ready =
    post.publishingEnabled &&
    post.revision.variants.length > 0 &&
    post.revision.variants.every((v) => v.publishingEnabled) &&
    !post.deliveries.length;
  async function approve() {
    await onAction(async () => {
      onUpdate(
        await socialRequest<SocialPost>(
          `/api/social/posts/${encodeURIComponent(post.id)}/approve`,
          "POST",
          { revisionId: post.revision.id, destinationIds: ids },
        ),
      );
      onNotice(
        `Revision ${post.revision.number} reviewed. This approval does not publish.`,
      );
    });
  }
  async function enqueue() {
    await onAction(async () => {
      const digest = JSON.stringify([
        post.revision.id,
        ids,
        timing,
        zone,
        scheduled,
      ]);
      if (submit.current?.digest !== digest)
        submit.current = {
          digest,
          enqueueId: crypto.randomUUID(),
          dueAt: timing === "now" ? new Date().toISOString() : scheduled,
        };
      const result = await socialRequest<SocialPost>(
        `/api/social/posts/${encodeURIComponent(post.id)}/enqueue`,
        "POST",
        {
          revisionId: post.revision.id,
          destinationIds: ids,
          enqueueId: submit.current.enqueueId,
          dueAt: submit.current.dueAt,
          timeZone: timing === "now" ? "UTC" : zone,
        },
      );
      onUpdate(result);
      onNotice(
        "Delivery request saved. Follow each destination's status below; provider confirmation is still required.",
      );
    });
  }
  return (
    <Card>
      <Stack gap={5}>
        <div>
          <Badge tone="primary">Saved revision {post.revision.number}</Badge>
          <Typography as="h2" variant="heading-2" className="mt-2">
            Review social post
          </Typography>
          <Typography tone="muted">
            Approval covers this exact content, media, provider settings, and
            destination list. Any edit creates a new revision and requires
            another review.
          </Typography>
        </div>
        <Typography as="h3" className="font-semibold">
          {post.title}
        </Typography>
        <Typography className="whitespace-pre-wrap break-words">
          {post.revision.body || "No shared caption"}
        </Typography>
        {post.revision.variants.map((v) => (
          <section
            key={v.id}
            className="rounded-box border border-base-300 p-4"
          >
            <Stack gap={3}>
              <div>
                <Typography as="h3" className="font-semibold">
                  {v.name ?? socialLabel(v.kind)}
                </Typography>
                <Badge>
                  {socialLabel(v.kind)} ·{" "}
                  {v.format === "SHORT_VIDEO"
                    ? "Short video"
                    : v.format === "IMAGE"
                      ? "Image"
                      : "Text"}
                </Badge>
              </div>
              {v.title ? (
                <Typography className="font-semibold">{v.title}</Typography>
              ) : null}
              <Typography className="whitespace-pre-wrap break-words">
                {v.body ?? post.revision.body}
              </Typography>
              <MediaPreview
                media={post.revision.media.filter((m) =>
                  (v.mediaIds ?? []).includes(m.id),
                )}
              />
              <ReviewedOptions options={v.providerOptions ?? {}} />
              {!v.publishingEnabled ? (
                <Typography variant="caption" tone="muted">
                  Publishing provider is disabled or has not been validated.
                </Typography>
              ) : null}
            </Stack>
          </section>
        ))}
        {!ids.length ? (
          <Alert title="Choose social destinations" tone="warning">
            This draft has no delivery destinations. Save your destination
            choices before approving.
          </Alert>
        ) : (
          <>
            <Checkbox
              label={`I reviewed revision ${post.revision.number} and every destination variant`}
              checked={reviewed}
              disabled={busy || approved}
              onChange={(e) => setReviewed(e.target.checked)}
            />
            <Button
              variant="secondary"
              disabled={busy || approved || !reviewed}
              onClick={() => void approve()}
            >
              {approved ? "Revision reviewed" : "Approve saved revision"}
            </Button>
          </>
        )}
        <Select
          label="Delivery timing"
          value={timing}
          options={[
            { label: "Publish now", value: "now" },
            { label: "Schedule for later", value: "schedule" },
          ]}
          disabled={busy}
          onChange={(e) => setTiming(e.target.value)}
        />
        {timing === "schedule" ? (
          <>
            <SocialSchedule
              zone={zone}
              localTime={localTime}
              chosen={chosen}
              onZone={setZone}
              onTime={setLocalTime}
              onChosen={setChosen}
              disabled={busy}
            />
            <Typography className="font-medium">
              {publicationTime(scheduled, zone)} · {utcTime(scheduled)}
            </Typography>
            {scheduled && !validFuture ? (
              <Typography role="alert" className="text-error">
                Choose a future time within one year.
              </Typography>
            ) : null}
          </>
        ) : (
          <Typography variant="caption">
            Publish immediately after submission, using UTC. Processing or
            provider review may delay availability.
          </Typography>
        )}
        {!ready ? (
          <Alert title="Publishing is blocked" tone="warning" role="note">
            {post.deliveries.length
              ? "This revision already has deliveries. Use their status and reschedule controls."
              : "The publishing provider must be explicitly enabled and validated for every destination. You can save and review this draft now; no delivery will be created."}
          </Alert>
        ) : null}
        <Button
          disabled={
            busy ||
            !approved ||
            !ready ||
            (timing === "schedule" && !validFuture)
          }
          onClick={() => void enqueue()}
        >
          {timing === "now"
            ? "Confirm and publish now"
            : "Confirm and schedule"}
        </Button>
      </Stack>
    </Card>
  );
}
