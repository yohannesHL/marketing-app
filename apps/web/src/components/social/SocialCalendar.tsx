"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Input,
  Select,
  Stack,
  Typography,
} from "@launchpad/ui";
import { SocialLayout } from "./SocialLayout";
import { initialTimeZone } from "./SocialSchedule";
import {
  localTimeInput,
  publicationTime,
  utcTime,
  validTimeZone,
} from "./socialTime";
import {
  deliveryLabel,
  postPath,
  socialLabel,
  socialRequest,
  socialStatus,
  SocialUiError,
  type SocialList,
  type SocialPost,
} from "./socialUi";
export function SocialCalendar({ embedded = false }: { embedded?: boolean }) {
  const [data, setData] = useState<SocialList | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [view, setView] = useState(embedded ? "calendar" : "list"),
    [filter, setFilter] = useState("ALL"),
    [zone, setZone] = useState(initialTimeZone),
    [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const load = useCallback(async () => {
    try {
      setData(await socialRequest<SocialList>("/api/social/posts"));
      setError(null);
    } catch (failure) {
      if (failure instanceof SocialUiError && failure.status === 401)
        window.location.replace("/sign-in?returnTo=%2Fsocial");
      else
        setError(
          failure instanceof SocialUiError
            ? failure.message
            : "The calendar could not load.",
        );
    } finally {
      setLoading(false);
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const posts =
      data?.posts.filter((p) => filter === "ALL" || p.status === filter) ?? [],
    calendarRows = posts.flatMap((post) =>
      post.deliveries.map((delivery) => ({
        post,
        delivery,
        date: localTimeInput(delivery.dueAt, zone).slice(0, 10),
      })),
    ),
    monthValid =
      /^\d{4}-\d{2}$/.test(month) &&
      Number(month.slice(5)) >= 1 &&
      Number(month.slice(5)) <= 12,
    first = monthValid ? new Date(`${month}-01T12:00:00Z`) : null,
    days = first
      ? new Date(
          Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
        ).getUTCDate()
      : 0,
    offset = first ? (first.getUTCDay() + 6) % 7 : 0;
  const cells = Array.from(
    { length: Math.ceil((days + offset) / 7) * 7 },
    (_, index) =>
      index >= offset && index < offset + days
        ? `${month}-${String(index - offset + 1).padStart(2, "0")}`
        : null,
  );
  const card = (post: SocialPost) => (
    <article key={post.id} className="rounded-box border border-base-300 p-4">
      <Stack gap={3}>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            className="link link-primary break-words font-semibold"
            href={postPath(post.id)}
          >
            {post.title}
          </Link>
          <Badge>{socialStatus(post.status)}</Badge>
          <Badge tone="primary">Revision {post.currentRevision}</Badge>
        </div>
        <Typography variant="caption" tone="muted">
          {post.revision.variants.length
            ? post.revision.variants
                .map(
                  (v) =>
                    `${socialLabel(v.kind)}: ${v.name ?? "Connected account"}`,
                )
                .join(" · ")
            : "No social destinations selected"}
        </Typography>
        <Typography className="line-clamp-3 whitespace-pre-wrap break-words">
          {post.revision.body || "No caption yet"}
        </Typography>
        {post.deliveries.length ? (
          post.deliveries.map((d) => (
            <div key={d.id} className="border-t border-base-300 pt-2">
              <Typography variant="caption">
                {deliveryLabel(d.status)} ·{" "}
                {publicationTime(d.dueAt, d.timeZone)} · {d.timeZone}
              </Typography>
              <Typography variant="caption" tone="muted">
                {utcTime(d.dueAt)}
              </Typography>
            </div>
          ))
        ) : (
          <Typography variant="caption" tone="muted">
            Not scheduled.{" "}
            {post.publishingEnabled
              ? "Review the saved revision before delivery."
              : "Publishing is blocked until providers are enabled and validated."}
          </Typography>
        )}
        <Link
          className="btn btn-secondary min-h-11 normal-case w-fit"
          href={postPath(post.id)}
        >
          Open draft and delivery details
        </Link>
      </Stack>
    </article>
  );
  return (
    <SocialLayout
      embedded={embedded}
      title="Publishing calendar"
      description="Plan social content and follow each delivery. Paid campaign plans remain in the advertising workflow."
      mode={data?.mode}
      loading={loading}
      busy={busy}
      error={error}
      onError={() => setError("Sign out could not complete. Try again.")}
    >
      {!data?.publishingEnabled ? (
        <Alert title="Draft planning is available" tone="warning" role="note">
          Provider publishing is currently disabled. Create, save, preview, and
          review posts here; scheduling will stay blocked until the selected
          providers are enabled and validated.
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex gap-2" role="group" aria-label="Publishing view">
          <Button
            variant={view === "list" ? "primary" : "secondary"}
            aria-pressed={view === "list"}
            onClick={() => setView("list")}
          >
            List
          </Button>
          <Button
            variant={view === "calendar" ? "primary" : "secondary"}
            aria-pressed={view === "calendar"}
            onClick={() => setView("calendar")}
          >
            Calendar
          </Button>
        </div>
        <Select
          label="Post status"
          value={filter}
          options={[
            { label: "All posts", value: "ALL" },
            ...["DRAFT", "APPROVED", "SCHEDULED", "COMPLETED", "CANCELLED"].map(
              (value) => ({ value, label: socialStatus(value) }),
            ),
          ]}
          onChange={(e) => setFilter(e.target.value)}
        />
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void load();
          }}
        >
          Refresh posts
        </Button>
      </div>
      {!posts.length ? (
        <Card>
          <Stack gap={3}>
            <Typography as="h2" variant="heading-2">
              {data?.posts.length
                ? "No posts match this status"
                : "Your social calendar starts with a draft"}
            </Typography>
            <Typography tone="muted">
              Add content now, then choose verified social destinations when
              they are available. Advertising grants do not authorize social
              publishing.
            </Typography>
            <Link
              href="/social/create"
              className="btn btn-primary min-h-11 normal-case w-fit"
            >
              Create social draft
            </Link>
          </Stack>
        </Card>
      ) : view === "list" ? (
        <div className="grid gap-4 lg:grid-cols-2">{posts.map(card)}</div>
      ) : (
        <Stack gap={4}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Calendar month"
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
            />
            <Input
              label="Calendar IANA time zone"
              value={zone}
              onChange={(e) => setZone(e.target.value)}
              error={
                !validTimeZone(zone)
                  ? "Enter a valid IANA time zone."
                  : undefined
              }
            />
          </div>
          {first && validTimeZone(zone) ? (
            <div
              tabIndex={0}
              role="region"
              aria-label="Monthly delivery calendar; scroll horizontally on small screens"
              className="overflow-x-auto rounded-box border border-base-300 focus:outline focus:outline-2 focus:outline-primary"
            >
              <table className="w-full min-w-[42rem] table-fixed border-collapse">
                <caption className="p-3 text-left font-semibold">
                  {new Intl.DateTimeFormat(undefined, {
                    month: "long",
                    year: "numeric",
                    timeZone: "UTC",
                  }).format(first)}{" "}
                  · {zone}
                </caption>
                <thead>
                  <tr>
                    {[
                      "Monday",
                      "Tuesday",
                      "Wednesday",
                      "Thursday",
                      "Friday",
                      "Saturday",
                      "Sunday",
                    ].map((day) => (
                      <th
                        key={day}
                        scope="col"
                        className="border border-base-300 p-2 text-xs"
                      >
                        {day}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: cells.length / 7 }, (_, week) => (
                    <tr key={week}>
                      {cells
                        .slice(week * 7, week * 7 + 7)
                        .map((date, index) => (
                          <td
                            key={index}
                            className="h-28 border border-base-300 p-2 align-top"
                          >
                            {date ? (
                              <>
                                <Typography
                                  variant="caption"
                                  className="font-semibold"
                                >
                                  {Number(date.slice(-2))}
                                </Typography>
                                {calendarRows
                                  .filter((row) => row.date === date)
                                  .map(({ post, delivery }) => (
                                    <Link
                                      key={delivery.id}
                                      href={postPath(post.id)}
                                      className="mt-2 block rounded border border-primary/20 bg-primary/5 p-1 text-xs text-primary"
                                    >
                                      <span className="block break-words font-semibold">
                                        {post.title}
                                      </span>
                                      <span className="block">
                                        {publicationTime(delivery.dueAt, zone)}
                                      </span>
                                      <span>
                                        {deliveryLabel(delivery.status)}
                                      </span>
                                    </Link>
                                  ))}
                              </>
                            ) : null}
                          </td>
                        ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {!calendarRows.some((row) => row.date.startsWith(month)) ? (
            <Typography role="status">
              No deliveries in this month. Unscheduled drafts are listed below.
            </Typography>
          ) : null}
          <Typography as="h2" variant="heading-2">
            Unscheduled drafts
          </Typography>
          <div className="grid gap-4 lg:grid-cols-2">
            {posts.filter((p) => !p.deliveries.length).map(card)}
          </div>
        </Stack>
      )}
      {(data?.posts.length ?? 0) >= 100 ? (
        <Typography variant="caption" tone="muted">
          Showing the 100 most recently updated posts.
        </Typography>
      ) : null}
    </SocialLayout>
  );
}
