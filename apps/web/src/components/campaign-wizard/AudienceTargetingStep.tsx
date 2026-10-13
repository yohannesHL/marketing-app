"use client";

import {
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
}: AudienceTargetingStepProps) {
  const selectedInterests = audience.interests
    ? audience.interests
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

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
              onToggle={() => toggleInterest(interest)}
            >
              {interest}
            </Tag>
          ))}
        </TagGroup>
      </div>

      <Card data-testid="audience-estimate" className="bg-base-200/50">
        <div className="flex flex-col gap-3">
          <Typography tone="muted" className="text-sm">
            Estimated Reach
          </Typography>
          <Typography variant="heading-2" className="font-bold">
            {estimate
              ? estimate.estimatedSize.toLocaleString()
              : isLoading
                ? "..."
                : "—"}
          </Typography>
          <Progress
            value={estimate?.indicatorValue ?? 0}
            max={100}
            className="w-48"
          />
        </div>
      </Card>
    </Stack>
  );
}
