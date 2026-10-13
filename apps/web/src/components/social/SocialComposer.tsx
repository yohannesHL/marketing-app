"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Input,
  Select,
  Stack,
  Textarea,
  Typography,
} from "@launchpad/ui";
import type { Connection, ProviderSettings } from "../connections/connectionUi";
import { SocialLayout } from "./SocialLayout";
import { MediaPreview } from "./MediaPreview";
import { ProviderControls } from "./ProviderControls";
import { tikTokConsentOnlyChange } from "./TikTokControls";
import { SocialReview } from "./SocialReview";
import { SocialDeliveries } from "./SocialDeliveries";
import {
  SOCIAL_PLATFORMS,
  postPath,
  socialDestinations,
  socialLabel,
  socialRequest,
  SocialUiError,
  type SocialDraft,
  type SocialMedia,
  type SocialPost,
  type SocialVariantInput,
} from "./socialUi";
function tikTokCheckKey(connection: Connection, destinationId: string) {
  const destination = connection.destinations.find((item) => item.id === destinationId);
  return JSON.stringify([connection.id, connection.providerUserId, connection.connectionMode,
    destination?.externalId, destination?.metadata?.tiktokCreator?.authorizationGeneration]);
}
const empty: SocialDraft = { title: "", body: "", mediaIds: [], variants: [] };
export function SocialComposer({ postId }: { postId?: string }) {
  const [draft, setDraft] = useState<SocialDraft>(empty),
    [post, setPost] = useState<SocialPost | null>(null),
    [media, setMedia] = useState<SocialMedia[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]),
    [mode, setMode] = useState<string>(),
    [tikTokAudited, setTikTokAudited] = useState(false),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null),
    [review, setReview] = useState(false);
  const [tikTokChecks, setTikTokChecks] = useState<Record<string, { key: string; status: "checking" | "fresh" | "failed" }>>({});
  const tikTokAttempts = useRef(new Set<string>());
  const pending = useRef(false),
    mounted = useRef(true),
    uploadInput = useRef<HTMLInputElement>(null);
  const acceptPost = useCallback((value: SocialPost) => {
    setPost(value);
    setDraft({
      title: value.title,
      body: value.revision.body,
      mediaIds: value.revision.media.map((m) => m.id),
      variants: value.revision.variants.map((v) => ({
        destinationId: v.destinationId,
        format: v.format,
        title: v.title ?? undefined,
        body: v.body ?? undefined,
        mediaIds: v.mediaIds,
        providerOptions: v.providerOptions ?? {},
      })),
    });
    setMedia(value.revision.media);
    setDirty(false);
  }, []);
  useEffect(() => {
    mounted.current = true;
    Promise.all([
      socialRequest<Connection[]>("/api/connections"),
      socialRequest<ProviderSettings>("/api/connections/providers"),
      postId
        ? socialRequest<SocialPost>(
            `/api/social/posts/${encodeURIComponent(postId)}`,
          )
        : Promise.resolve(null),
    ])
      .then(([rows, settings, value]) => {
        if (!mounted.current) return;
        setConnections(rows);
        setMode(settings.mode);
        setTikTokAudited((settings.social.find((row) => row.provider === "TIKTOK") as { audited?: boolean } | undefined)?.audited === true);
        if (value) acceptPost(value);
      })
      .catch((failure) => {
        if (failure instanceof SocialUiError && failure.status === 401)
          window.location.replace(
            `/sign-in?returnTo=${encodeURIComponent(postId ? postPath(postId) : "/social/create")}`,
          );
        else
          setError(
            failure instanceof Error
              ? failure.message
              : "Your workspace could not load.",
          );
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
    return () => {
      mounted.current = false;
    };
  }, [postId, acceptPost]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const isTikTok = (id: string) => connections.some((connection) => connection.destinations.some((destination) => destination.id === id && destination.kind === "TIKTOK_PROFILE")) ||
    post?.revision.variants.some((variant) => variant.destinationId === id && variant.kind === "TIKTOK_PROFILE") === true;
  const change = (update: SocialDraft | ((current: SocialDraft) => SocialDraft),
    consentOnly: boolean | ((current: SocialDraft) => boolean) = false) => {
    setDraft((current) => {
      const next = typeof update === "function" ? update(current) : update;
      const preserveConsent = typeof consentOnly === "function" ? consentOnly(current) : consentOnly;
      return preserveConsent ? next : { ...next, variants: next.variants.map((variant) => isTikTok(variant.destinationId) ?
        { ...variant, providerOptions: { ...variant.providerOptions, explicitPostingConsent: false } } : variant) };
    });
    setDirty(true);
    setReview(false);
    setNotice(null);
  };
  const destinations = socialDestinations(connections, mode ?? "");
  async function action(work: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (failure) {
      if (failure instanceof SocialUiError && failure.status === 401)
        window.location.replace(
          `/sign-in?returnTo=${encodeURIComponent(postId ? postPath(postId) : "/social/create")}`,
        );
      else
        setError(
          failure instanceof SocialUiError
            ? failure.message
            : "The request could not be completed. Try again.",
        );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function save(showReview = false, navigate?: string) {
    await action(async () => {
      const saved = await socialRequest<SocialPost>(
        post
          ? `/api/social/posts/${encodeURIComponent(post.id)}`
          : "/api/social/posts",
        post ? "PATCH" : "POST",
        { ...draft, ...(post ? { revisionId: post.revision.id } : {}) },
      );
      acceptPost(saved);
      setNotice(
        `Revision ${saved.revision.number} saved. ${saved.publishingEnabled ? "Review before publishing." : "Publishing is currently blocked."}`,
      );
      setReview(showReview);
      if (navigate) window.location.assign(navigate);
      else if (!postId)
        window.history.replaceState(null, "", postPath(saved.id));
    });
  }
  function variant(destinationId: string, patch: Partial<SocialVariantInput>) {
    change((current) => ({ ...current, variants: current.variants.map((v) => v.destinationId === destinationId ? { ...v, ...patch } : v) }),
      (current) => isTikTok(destinationId) && Object.keys(patch).length === 1 && patch.providerOptions !== undefined &&
        tikTokConsentOnlyChange(current.variants.find((item) => item.destinationId === destinationId)?.providerOptions ?? {}, patch.providerOptions));
  }
  async function checkTikTok(connection: Connection, destinationId: string) {
    const key = tikTokCheckKey(connection, destinationId);
    tikTokAttempts.current.add(key);
    setTikTokChecks((current) => ({ ...current, [destinationId]: { key, status: "checking" } }));
    // Cached creator evidence cannot authorize consent on this composer visit.
    // Clear only posting choices; keep all dirty text, media and destinations.
    change((current) => ({ ...current, variants: current.variants.map((variant) => variant.destinationId === destinationId ? { ...variant, providerOptions: {} } : variant) }));
    try {
      const refreshed = await socialRequest<{ connection: Connection }>(
        `/api/connections/tiktok/${encodeURIComponent(connection.id)}/check`, "POST", { destinationId });
      if (!mounted.current) return;
      const freshKey = tikTokCheckKey(refreshed.connection, destinationId);
      tikTokAttempts.current.add(freshKey);
      setConnections((current) => current.map((item) => item.id === refreshed.connection.id ? refreshed.connection : item));
      setTikTokChecks((current) => ({ ...current, [destinationId]: { key: freshKey, status: "fresh" } }));
    } catch (failure) {
      if (mounted.current) setTikTokChecks((current) => ({ ...current, [destinationId]: { key, status: "failed" } }));
      throw failure;
    }
  }
  useEffect(() => {
    if (loading) return;
    for (const variant of draft.variants) {
      const row = destinations.find((item) => item.destination.id === variant.destinationId);
      if (!row?.ready || row.destination.kind !== "TIKTOK_PROFILE") continue;
      const key = tikTokCheckKey(row.connection, row.destination.id);
      // A failed automatic check needs an explicit retry. Metadata updates from
      // our successful check must not trigger an endless provider-check loop.
      if (tikTokAttempts.current.has(key)) continue;
      void checkTikTok(row.connection, row.destination.id).catch((failure) => {
        if (!mounted.current) return;
        if (failure instanceof SocialUiError && failure.status === 401)
          window.location.replace(`/sign-in?returnTo=${encodeURIComponent(postId ? postPath(postId) : "/social/create")}`);
        else setError(failure instanceof SocialUiError ? failure.message : "The request could not be completed. Try again.");
      });
    }
  }, [loading, draft.variants, connections, mode]);
  async function refreshTikTok(connection: Connection, destinationId: string) {
    await action(async () => {
      await checkTikTok(connection, destinationId);
      setNotice("TikTok creator settings refreshed. Review privacy, interactions, disclosures and this exact video again before giving posting consent.");
    });
  }
  async function upload(file: File) {
    await action(async () => {
      const form = new FormData();
      form.append("file", file);
      const item = await socialRequest<SocialMedia>(
        "/api/social/media",
        "POST",
        form,
      );
      setMedia((items) => [...items, item]);
      change((current) => ({ ...current, mediaIds: [...current.mediaIds, item.id] }));
      setNotice(
        "Media uploaded and inspected. Choose it for each destination variant before saving.",
      );
    });
    if (uploadInput.current) uploadInput.current.value = "";
  }
  return (
    <SocialLayout
      title={post ? "Edit social post" : "Create social post"}
      description="Compose owned content, choose social destinations, and review the exact saved revision. Paid campaign drafts stay in their own workflow."
      mode={mode}
      loading={loading}
      busy={busy}
      error={error}
      notice={notice}
      onError={() => setError("Sign out could not complete. Try again.")}
      onNavigate={
        dirty || (post !== null && !postId)
          ? (href) => {
              if (!busy) {
                if (dirty) void save(false, href);
                else window.location.assign(href);
              }
            }
          : undefined
      }
    >
      {post?.deliveries.some((delivery) =>
        ["QUEUED", "LEASED", "RETRY_WAIT", "BLOCKED", "UNCERTAIN"].includes(
          delivery.status,
        ),
      ) ? (
        <Alert
          title="Editing affects existing deliveries"
          tone="warning"
          role="note"
        >
          Saving changes replaces this revision&apos;s queued deliveries and
          requires a fresh review. A publication already in flight may still
          complete and will need its outcome checked.
        </Alert>
      ) : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap={6}>
          <Card>
            <Stack gap={4}>
              <Typography as="h2" variant="heading-2">
                Content
              </Typography>
              <Input
                label="Draft title"
                required
                maxLength={200}
                value={draft.title}
                disabled={busy}
                onChange={(e) => change({ ...draft, title: e.target.value })}
                description="A name for this draft. Each destination can have its own published title."
              />
              <Textarea
                label="Caption or post text"
                maxLength={10000}
                value={draft.body}
                disabled={busy}
                onChange={(e) => change({ ...draft, body: e.target.value })}
              />
              <Typography variant="caption" tone="muted">
                {draft.body.length.toLocaleString()} characters.
                Provider-specific limits are checked before publishing.
              </Typography>
              <label className="font-medium" htmlFor="social-media-upload">
                Upload image or video
              </label>
              <input
                id="social-media-upload"
                ref={uploadInput}
                type="file"
                accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime"
                disabled={busy || media.length >= 10}
                className="file-input file-input-bordered min-h-11 w-full"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void upload(file);
                }}
              />
              <Typography variant="caption" tone="muted">
                Files are inspected on upload. Availability and platform limits
                are rechecked before delivery. Up to 10 attachments per draft.
              </Typography>
              <MediaPreview media={media} />
              {media.map((item) => (
                <Button
                  key={item.id}
                  variant="ghost"
                  className="h-auto min-h-11 max-w-full whitespace-normal break-all"
                  disabled={busy}
                  onClick={() => {
                    setMedia((items) => items.filter((m) => m.id !== item.id));
                    change({
                      ...draft,
                      mediaIds: draft.mediaIds.filter((id) => id !== item.id),
                      variants: draft.variants.map((v) => ({
                        ...v,
                        mediaIds: (v.mediaIds ?? draft.mediaIds).filter(
                          (id) => id !== item.id,
                        ),
                      })),
                    });
                  }}
                >
                  Remove {item.filename ?? "attachment"}
                </Button>
              ))}
            </Stack>
          </Card>
          <Card>
            <Stack gap={4}>
              <Typography as="h2" variant="heading-2" className="break-words">
                Social destinations
              </Typography>
              <Typography tone="muted">
                Only selected social publishing accounts with verified write
                access can be added. Connect and select them in Connections.
              </Typography>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {SOCIAL_PLATFORMS.map((platform) => {
                  const rows = destinations.filter(({ destination }) =>
                    platform.kind === "LINKEDIN"
                      ? destination.kind.startsWith("LINKEDIN")
                      : destination.kind === platform.kind,
                  );
                  return (
                    <div
                      key={platform.kind}
                      className="rounded-box border border-base-300 p-3"
                    >
                      <Typography as="h3" className="font-semibold">
                        {platform.label}
                      </Typography>
                      <Typography variant="caption" tone="muted">
                        {rows.some((row) => row.ready)
                          ? "Selected publishing account available"
                          : "Publishing connection required"}
                      </Typography>
                      {rows.map(({ destination, ready }) => (
                        <Checkbox
                          key={destination.id}
                          label={destination.name ?? platform.label}
                          description={
                            ready
                              ? "Write access verified; provider publishing must also be enabled."
                              : "Reconnect, verify permissions, or select this social account."
                          }
                          checked={draft.variants.some(
                            (v) => v.destinationId === destination.id,
                          )}
                          disabled={busy || !ready}
                          onChange={(e) =>
                            change({
                              ...draft,
                              variants: e.target.checked
                                ? [
                                    ...draft.variants,
                                    {
                                      destinationId: destination.id,
                                      format: [
                                        "YOUTUBE_CHANNEL",
                                        "TIKTOK_PROFILE",
                                        "INSTAGRAM_PROFILE",
                                      ].includes(destination.kind)
                                        ? "SHORT_VIDEO"
                                        : "TEXT",
                                      mediaIds: [],
                                      providerOptions: {},
                                    },
                                  ]
                                : draft.variants.filter(
                                    (v) => v.destinationId !== destination.id,
                                  ),
                            })
                          }
                        />
                      ))}
                    </div>
                  );
                })}
              </div>
              {!draft.variants.length ? (
                <Alert
                  title="Drafts can be saved without destinations"
                  role="note"
                >
                  Publishing and scheduling stay blocked until you choose social
                  destinations and an enabled provider.
                </Alert>
              ) : null}
              <Link
                className="btn btn-secondary min-h-11 normal-case"
                href="/connections"
                onClick={(e) => {
                  if (dirty) {
                    e.preventDefault();
                    void save(false, "/connections");
                  }
                }}
              >
                {dirty
                  ? "Save draft and manage connections"
                  : "Manage social connections"}
              </Link>
            </Stack>
          </Card>
          {draft.variants.map((v) => {
            const row = destinations.find(
                (r) => r.destination.id === v.destinationId,
              ),
              saved = post?.revision.variants.find(
                (r) => r.destinationId === v.destinationId,
              );
            const kind = row?.destination.kind ?? saved?.kind ?? "",
              name =
                row?.destination.name ?? saved?.name ?? "Social destination";
            return (
              <Card key={v.destinationId}>
                <Stack gap={4}>
                  <div>
                    <Typography as="h2" variant="heading-2">
                      {name}
                    </Typography>
                    <Badge tone="primary">{socialLabel(kind)}</Badge>
                  </div>
                  <Select
                    label={`Format for ${name}`}
                    value={v.format}
                    disabled={busy}
                    options={[
                      ...(![
                        "YOUTUBE_CHANNEL",
                        "INSTAGRAM_PROFILE",
                        "TIKTOK_PROFILE",
                      ].includes(kind)
                        ? [{ label: "Text", value: "TEXT" }]
                        : []),
                      ...(!["YOUTUBE_CHANNEL", "TIKTOK_PROFILE"].includes(kind)
                        ? [{ label: "Image", value: "IMAGE" }]
                        : []),
                      { label: "Short video", value: "SHORT_VIDEO" },
                    ]}
                    onChange={(e) =>
                      variant(v.destinationId, {
                        format: e.target.value as SocialVariantInput["format"],
                        mediaIds: [],
                        ...(["FACEBOOK_PAGE", "INSTAGRAM_PROFILE", "TIKTOK_PROFILE"].includes(kind) ? { providerOptions: {} } : {}),
                      })
                    }
                  />
                  <Input
                    label={`Published title for ${name}`}
                    maxLength={200}
                    value={v.title ?? ""}
                    disabled={busy}
                    onChange={(e) =>
                      variant(v.destinationId, { title: e.target.value })
                    }
                  />
                  <Textarea
                    label={`Caption for ${name}`}
                    value={v.body ?? draft.body}
                    maxLength={10000}
                    disabled={busy}
                    onChange={(e) =>
                      variant(v.destinationId, { body: e.target.value })
                    }
                  />
                  {v.format !== "TEXT" ? (
                    <fieldset className="grid gap-2">
                      <legend className="font-medium">
                        Attachments for {name}
                      </legend>
                      {media
                        .filter((m) =>
                          v.format === "IMAGE"
                            ? m.type === "IMAGE"
                            : m.type === "VIDEO",
                        )
                        .map((m) => (
                          <Checkbox
                            key={m.id}
                            label={
                              m.filename ?? `${m.type.toLowerCase()} attachment`
                            }
                            checked={(v.mediaIds ?? []).includes(m.id)}
                            disabled={busy}
                            onChange={(e) =>
                              variant(v.destinationId, {
                                mediaIds:
                                  v.format === "SHORT_VIDEO"
                                    ? e.target.checked
                                      ? [m.id]
                                      : []
                                    : e.target.checked
                                      ? [...(v.mediaIds ?? []), m.id]
                                      : (v.mediaIds ?? []).filter(
                                          (id) => id !== m.id,
                                        ),
                              })
                            }
                          />
                        ))}
                      {!media.some((m) =>
                        v.format === "IMAGE"
                          ? m.type === "IMAGE"
                          : m.type === "VIDEO",
                      ) ? (
                        <Typography variant="caption" tone="muted">
                          Upload {v.format === "IMAGE" ? "an image" : "a video"}{" "}
                          to choose an attachment.
                        </Typography>
                      ) : null}
                    </fieldset>
                  ) : null}
                  {kind === "TIKTOK_PROFILE" && tikTokChecks[v.destinationId]?.status === "checking" ?
                    <Typography role="status" variant="caption">Checking current TikTok creator settings. Posting consent stays unavailable until this completes.</Typography> : null}
                  <ProviderControls
                    kind={kind}
                    format={v.format}
                    options={v.providerOptions ?? {}}
                    disabled={busy}
                    creator={kind === "TIKTOK_PROFILE" && row?.ready && tikTokChecks[v.destinationId]?.status === "fresh" &&
                      tikTokChecks[v.destinationId]?.key === tikTokCheckKey(row.connection, row.destination.id) && row.destination.metadata?.tiktokCreator?.authorizationId === row.connection.id &&
                      row.destination.metadata.tiktokCreator.openId === row.destination.externalId ? row.destination.metadata.tiktokCreator : undefined}
                    xQuoteInput={kind === "X_PROFILE" && row?.ready ? { destinationId: v.destinationId, body: v.body ?? draft.body,
                      format: v.format, mediaIds: v.mediaIds ?? draft.mediaIds } : undefined}
                    audited={tikTokAudited}
                    video={kind === "TIKTOK_PROFILE" && (v.mediaIds ?? []).length === 1 ? media.find((item) => item.id === v.mediaIds![0] && item.type === "VIDEO") : undefined}
                    onRefresh={kind === "TIKTOK_PROFILE" && row && tikTokChecks[v.destinationId]?.status !== "checking" ? () => { void refreshTikTok(row.connection, row.destination.id); } : undefined}
                    onChange={(options) =>
                      variant(v.destinationId, { providerOptions: options })
                    }
                  />
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      change({
                        ...draft,
                        variants: draft.variants.filter(
                          (item) => item.destinationId !== v.destinationId,
                        ),
                      })
                    }
                  >
                    Remove {name} from this post
                  </Button>
                </Stack>
              </Card>
            );
          })}
          <div className="flex flex-wrap gap-3">
            <Button type="submit" loading={busy} disabled={busy}>
              Save draft
            </Button>
            <Button
              variant="secondary"
              disabled={busy || !draft.title.trim()}
              onClick={() => {
                if (dirty || !post) void save(true);
                else setReview(true);
              }}
            >
              Save and review
            </Button>
            <Button
              variant="ghost"
              disabled={busy || !draft.title.trim()}
              onClick={() => void save(false, "/social")}
            >
              Save and open calendar
            </Button>
          </div>
          {dirty ? (
            <Typography role="status" variant="caption">
              Unsaved changes. Save this draft before switching workflows.
            </Typography>
          ) : null}
        </Stack>
      </form>
      {post && review && !dirty ? (
        <SocialReview
          key={post.revision.id}
          post={post}
          busy={busy}
          onAction={(work) => action(work)}
          onUpdate={acceptPost}
          onNotice={setNotice}
        />
      ) : null}
      {post?.deliveries.length ? (
        <SocialDeliveries
          post={post}
          busy={busy || dirty}
          onAction={(work) => action(work)}
          onUpdate={acceptPost}
        />
      ) : null}
    </SocialLayout>
  );
}
