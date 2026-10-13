"use client";
import {
  Input,
  Select,
  Stack,
  Typography,
} from "@launchpad/ui";
import type { TrustedTikTokCreator } from "../connections/connectionUi";
import type { SocialMedia } from "./socialUi";
import { XControls, type XQuoteInput } from "./XControls";
import { microsToUsd } from "../connections/connectionUi";
import { TikTokControls } from "./TikTokControls";
export function ProviderControls({
  kind,
  format,
  options,
  onChange,
  disabled = false,
  creator, audited, onRefresh, video, xQuoteInput,
}: {
  kind: string;
  format?: "TEXT" | "IMAGE" | "SHORT_VIDEO";
  options: Record<string, unknown>;
  onChange: (options: Record<string, unknown>) => void;
  disabled?: boolean; creator?: TrustedTikTokCreator; audited?: boolean; onRefresh?: () => void; video?: SocialMedia; xQuoteInput?: XQuoteInput;
}) {
  const set = (key: string, value: unknown) => {
    const next = { ...options };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onChange(next);
  };
  const boolean = (key: string, label: string) => (
    <Select
      key={key}
      label={label}
      value={options[key] === true ? "yes" : options[key] === false ? "no" : ""}
      disabled={disabled}
      placeholder="Choose explicitly"
      options={[
        { label: "Yes", value: "yes" },
        { label: "No", value: "no" },
      ]}
      onChange={(event) =>
        set(
          key,
          event.target.value === "" ? undefined : event.target.value === "yes",
        )
      }
    />
  );
  if (kind === "YOUTUBE_CHANNEL")
    return (
      <Stack gap={3}>
        <Input
          label="YouTube category ID"
          description="Choose the category for this channel. The connected provider will validate it before publishing."
          inputMode="numeric"
          value={String(options.categoryId ?? "")}
          disabled={disabled}
          onChange={(e) => set("categoryId", e.target.value || undefined)}
        />
        <Select
          label="YouTube privacy"
          placeholder="Choose privacy"
          value={String(options.privacyStatus ?? "")}
          disabled={disabled}
          options={[
            { label: "Public", value: "public" },
            { label: "Unlisted", value: "unlisted" },
            { label: "Private", value: "private" },
          ]}
          onChange={(e) => set("privacyStatus", e.target.value || undefined)}
        />
        {boolean("madeForKids", "Made for kids")}
        {boolean(
          "containsSyntheticMedia",
          "Altered or synthetic content disclosure",
        )}
      </Stack>
    );
  if (kind === "TIKTOK_PROFILE")
    return <TikTokControls creator={creator} audited={audited} options={options} onChange={onChange} onRefresh={onRefresh} video={video} disabled={disabled} />;
  if (kind === "FACEBOOK_PAGE")
    return format === "SHORT_VIDEO" ? boolean("isAigc", "Facebook Reel includes AI-generated content") : null;
  if (kind === "INSTAGRAM_PROFILE")
    return format === "SHORT_VIDEO" ? boolean("shareToFeed", "Also share the Reel to the Instagram feed") : null;
  if (kind.startsWith("LINKEDIN"))
    return (
      <Stack gap={3}>
        <Typography variant="caption">
          Publishing author:{" "}
          {kind === "LINKEDIN_ORGANIZATION"
            ? "organization with verified posting role"
            : "connected member"}
          . The provider must verify this author before publishing.
        </Typography>
        <Select
          label="LinkedIn visibility"
          placeholder="Choose visibility"
          value={String(options.visibility ?? "")}
          disabled={disabled}
          options={[
            { label: "Public", value: "PUBLIC" },
            ...(kind === "LINKEDIN_MEMBER"
              ? [{ label: "Connections", value: "CONNECTIONS" }]
              : []),
          ]}
          onChange={(e) => set("visibility", e.target.value || undefined)}
        />
      </Stack>
    );
  if (kind === "X_PROFILE")
    return <XControls options={options} onChange={onChange} disabled={disabled} quoteInput={xQuoteInput} />;
  return (
    <Typography variant="caption" tone="muted">
      Instagram format and professional account permissions will be checked by
      the connected publishing provider.
    </Typography>
  );
}
export function ReviewedOptions({
  options,
}: {
  options: Record<string, unknown>;
}) {
  const labels: Record<string, string> = {
    categoryId: "Category ID",
    privacyStatus: "Privacy",
    madeForKids: "Made for kids",
    containsSyntheticMedia: "Synthetic content",
    privacyLevel: "TikTok privacy",
    disableComment: "Comments disabled",
    disableDuet: "Duet disabled",
    disableStitch: "Stitch disabled",
    brandContentToggle: "Branded content",
    commercialContentDisclosure: "Commercial content disclosure",
    brandOrganicToggle: "Own brand",
    musicUsageConsent: "Music consent",
    isAigc: "AI-generated content",
    explicitPostingConsent: "Posting consent",
    creatorInfoVersion: "Creator settings version",
    shareToFeed: "Share to feed",
    visibility: "Visibility",
    madeWithAi: "Made with AI",
    paidPartnership: "Paid partnership",
    maxApiCostMicros: "Maximum X API cost (USD)",
  };
  return Object.keys(options).length ? (
    <dl className="grid gap-1 text-sm">
      {Object.entries(options).map(([key, value]) => (
        <div key={key} className="flex flex-wrap gap-x-2">
          <dt className="font-medium">{labels[key] ?? "Provider setting"}:</dt>
          <dd className="min-w-0 break-all">
            {key === "maxApiCostMicros" && Number.isSafeInteger(Number(value)) ? `US$${microsToUsd(Number(value))}` : typeof value === "boolean"
              ? value
                ? "Yes"
                : "No"
              : String(value)}
          </dd>
        </div>
      ))}
    </dl>
  ) : (
    <Typography variant="caption" tone="muted">
      Provider controls have not been chosen.
    </Typography>
  );
}
