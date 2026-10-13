"use client";

import {
  Alert,
  Card,
  Grid,
  Input,
  Progress,
  Select,
  Stack,
  Tag,
  TagGroup,
  Typography,
} from "@launchpad/ui";

import type { AudienceEstimateResponse } from "@launchpad/core";

import {
  genderOptions,
  type AudienceFormState,
  type GenderSelection,
} from "./state";

const availableInterests = [
  "Technology",
  "SaaS",
  "Marketing",
  "E-commerce",
  "Finance",
  "Health",
  "Education",
  "Design",
  "AI/ML",
  "Crypto",
];

type AudienceTargetingStepProps = {
  audience: AudienceFormState;
  estimate: AudienceEstimateResponse | null;
  estimateError: string | null;
  uploadError: string | null;
  isLoading: boolean;
  onFieldChange: <Field extends keyof AudienceFormState>(
    field: Field,
    value: AudienceFormState[Field],
  ) => void;
  onAudienceUpload: (file: File | null) => void;
};

export function AudienceTargetingStep({
  audience,
  estimate,
  estimateError,
  uploadError,
  isLoading,
  onFieldChange,
  onAudienceUpload,
}: AudienceTargetingStepProps) {
  const selectedInterests = audience.interests
    ? audience.interests
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const canEstimate = audience.location.trim().length > 0 && !uploadError;
  const isEstimating = canEstimate && isLoading;
  const currentEstimate = canEstimate ? estimate : null;

  const toggleInterest = (interest: string) => {
    const current = new Set(selectedInterests);
    if (current.has(interest)) {
      current.delete(interest);
    } else {
      current.add(interest);
    }
    onFieldChange("interests", Array.from(current).join(", "));
  };

  return (
    <Stack gap={8}>
      <div>
        <Typography variant="heading-3" className="mb-2">
          Audience Targeting
        </Typography>
        <Typography tone="muted" className="mb-6">
          Define who should see your ads.
        </Typography>

        <Grid minItemWidth="16rem" className="mb-6">
          <Input
            label="Location"
            onChange={(event) => onFieldChange("location", event.target.value)}
            placeholder="US, UK, Canada"
            value={audience.location}
          />
          <Select
            label="Gender"
            onChange={(event) =>
              onFieldChange("gender", event.target.value as GenderSelection)
            }
            options={genderOptions.map((g) => ({
              label: g.label,
              value: g.value,
            }))}
            placeholder="All"
            value={audience.gender}
          />
        </Grid>

        <Grid minItemWidth="16rem" className="mb-6">
          <Input
            label="Min Age"
            type="number"
            min={13}
            max={100}
            onChange={(event) => onFieldChange("minAge", event.target.value)}
            placeholder="18"
            value={audience.minAge || ""}
          />
          <Input
            label="Max Age"
            type="number"
            min={13}
            max={100}
            onChange={(event) => onFieldChange("maxAge", event.target.value)}
            placeholder="65"
            value={audience.maxAge || ""}
          />
        </Grid>

        <TagGroup label="Interests" className="mb-6">
          {availableInterests.map((interest) => (
            <Tag
              key={interest}
              selected={selectedInterests.includes(interest)}
              aria-pressed={selectedInterests.includes(interest)}
              onToggle={() => toggleInterest(interest)}
            >
              {interest}
            </Tag>
          ))}
        </TagGroup>
        <Grid minItemWidth="16rem" className="mb-6">
          <Input
            label="Industry"
            value={audience.industry}
            placeholder="Software"
            onChange={(event) => onFieldChange("industry", event.target.value)}
          />
          <Input
            label="Job titles"
            value={audience.jobTitles}
            placeholder="Marketing Director, Growth Manager"
            onChange={(event) => onFieldChange("jobTitles", event.target.value)}
          />
        </Grid>
        <Input
          label="Custom audience upload"
          type="file"
          accept=".csv,.txt"
          hint="Optional CSV or TXT file, up to 5 MB."
          error={uploadError}
          aria-invalid={Boolean(uploadError)}
          onChange={(event) => onAudienceUpload(event.target.files?.[0] ?? null)}
        />
        {audience.customAudienceFileName && (
          <Typography className="mt-2 text-sm" tone="muted">
            Selected audience: {audience.customAudienceFileName}
          </Typography>
        )}
      </div>

      <Card data-testid="audience-estimate" className="bg-base-200/50" aria-busy={isEstimating}>
        <div className="flex flex-col gap-3">
          <Typography tone="muted" className="text-sm">
            Estimated Reach
          </Typography>
          <Typography variant="heading-2" className="font-bold">
            {isEstimating
              ? "..."
              : currentEstimate
              ? currentEstimate.estimatedSize.toLocaleString()
              : "—"}
          </Typography>
          <Progress
            value={isEstimating ? 0 : currentEstimate?.indicatorValue ?? 0}
            max={100}
            className="w-48"
          />
          {uploadError ? (
            <Typography tone="muted" className="text-sm">Replace the rejected file to calculate estimated reach.</Typography>
          ) : isEstimating ? (
            <Typography role="status" tone="muted">Calculating audience estimate…</Typography>
          ) : estimateError ? (
            <Alert title="Audience estimate unavailable" tone="danger">
              {estimateError} Update your targeting to request a new estimate.
            </Alert>
          ) : currentEstimate ? (
            <Typography tone="muted" className="text-sm">{currentEstimate.summary}</Typography>
          ) : (
            <Typography tone="muted" className="text-sm">Enter a location to calculate estimated reach.</Typography>
          )}
        </div>
      </Card>
    </Stack>
  );
}
