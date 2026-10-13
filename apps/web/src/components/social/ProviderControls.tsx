"use client";
import {
  Alert,
  Checkbox,
  Input,
  Select,
  Stack,
  Typography,
} from "@launchpad/ui";
export function ProviderControls({
  kind,
  options,
  onChange,
  disabled = false,
}: {
  kind: string;
  options: Record<string, unknown>;
  onChange: (options: Record<string, unknown>) => void;
  disabled?: boolean;
}) {
  const commercial = options.commercialContentDisclosure === true;
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
    return (
      <Stack gap={3}>
        <Alert
          title="TikTok creator settings required"
          tone="warning"
          role="note"
        >
          Fresh creator settings must supply the nickname, permitted privacy
          choices, and interaction limits before publishing. Those settings are
          unavailable while this provider is disabled. No privacy choice is
          assumed.
        </Alert>
        <Select
          label="TikTok privacy"
          placeholder="Fresh creator settings unavailable"
          value=""
          disabled
          options={[]}
        />
        {[
          ["disableComment", "Allow comments"],
          ["disableDuet", "Allow Duet"],
          ["disableStitch", "Allow Stitch"],
        ].map(([key, label]) => (
          <Checkbox
            key={key}
            label={label}
            checked={options[key] === false}
            disabled
            onChange={() => {}}
          />
        ))}
        <Checkbox
          label="This post promotes a brand, product, or service"
          checked={commercial}
          disabled={disabled}
          onChange={(e) => {
            if (e.target.checked) set("commercialContentDisclosure", true);
            else
              onChange({
                ...options,
                commercialContentDisclosure: false,
                brandContentToggle: false,
                brandOrganicToggle: false,
              });
          }}
        />
        {commercial ? (
          <>
            <Typography variant="caption">
              Choose the commercial content disclosure explicitly.
            </Typography>
            <Checkbox
              label="My brand"
              checked={options.brandOrganicToggle === true}
              disabled={disabled}
              onChange={(e) => set("brandOrganicToggle", e.target.checked)}
            />
            <Checkbox
              label="Branded content for another business"
              checked={options.brandContentToggle === true}
              disabled={disabled || options.privacyLevel === "SELF_ONLY"}
              description={
                options.privacyLevel === "SELF_ONLY"
                  ? "Branded content cannot use private visibility."
                  : undefined
              }
              onChange={(e) => set("brandContentToggle", e.target.checked)}
            />
            {options.brandContentToggle === true ? (
              <Typography variant="caption">
                The video will carry a Paid partnership label.
              </Typography>
            ) : options.brandOrganicToggle === true ? (
              <Typography variant="caption">
                The video will carry a Promotional content label.
              </Typography>
            ) : (
              <Typography variant="caption">
                Choose your brand, another business, or both before posting.
              </Typography>
            )}
          </>
        ) : null}
        <Checkbox
          label={
            options.brandContentToggle === true
              ? "I agree to TikTok's Branded Content Policy and Music Usage Confirmation"
              : "I agree to TikTok's Music Usage Confirmation"
          }
          checked={options.musicUsageConsent === true}
          disabled={disabled}
          onChange={(e) => set("musicUsageConsent", e.target.checked)}
        />
        <Typography variant="caption">
          By posting, you agree to TikTok&apos;s{" "}
          {options.brandContentToggle === true ? (
            <>
              <a
                className="link link-primary"
                href="https://www.tiktok.com/legal/page/global/bc-policy/en"
                target="_blank"
                rel="noopener noreferrer"
              >
                Branded Content Policy
              </a>{" "}
              and{" "}
            </>
          ) : null}
          <a
            className="link link-primary"
            href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en"
            target="_blank"
            rel="noopener noreferrer"
          >
            Music Usage Confirmation
          </a>
          .
        </Typography>
        <Checkbox
          label="This video includes AI-generated content"
          checked={options.isAigc === true}
          disabled={disabled}
          onChange={(e) => set("isAigc", e.target.checked)}
        />
        <Typography variant="caption" tone="muted">
          Final posting consent is required after fresh creator settings and the
          exact post have been reviewed.
        </Typography>
      </Stack>
    );
  if (kind === "FACEBOOK_PAGE")
    return (
      <Checkbox
        label="Also share the Reel to the Facebook feed"
        checked={options.shareToFeed === true}
        disabled={disabled}
        onChange={(e) => set("shareToFeed", e.target.checked)}
      />
    );
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
    return (
      <Stack gap={3}>
        <Alert title="X publishing incurs API costs" tone="warning" role="note">
          A provider-verified weighted text count and cost estimate are required
          before approval to spend. Character count alone cannot confirm an X
          post fits.
        </Alert>
        <Input
          label="Maximum API cost (USD micros)"
          description="1,000,000 micros = US$1. The actual provider must check cost and account credits before publishing."
          inputMode="numeric"
          value={String(options.maxApiCostMicros ?? "")}
          disabled={disabled}
          onChange={(e) => set("maxApiCostMicros", e.target.value || undefined)}
        />
        <Checkbox
          label="Made with AI disclosure"
          checked={options.madeWithAi === true}
          disabled={disabled}
          onChange={(e) => set("madeWithAi", e.target.checked)}
        />
        <Checkbox
          label="Paid partnership disclosure"
          checked={options.paidPartnership === true}
          disabled={disabled}
          onChange={(e) => set("paidPartnership", e.target.checked)}
        />
      </Stack>
    );
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
    maxApiCostMicros: "Maximum API cost (USD micros)",
  };
  return Object.keys(options).length ? (
    <dl className="grid gap-1 text-sm">
      {Object.entries(options).map(([key, value]) => (
        <div key={key} className="flex flex-wrap gap-x-2">
          <dt className="font-medium">{labels[key] ?? "Provider setting"}:</dt>
          <dd>
            {typeof value === "boolean"
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
