"use client";

import {
  AdPreview,
  Button,
  Card,
  Grid,
  Icon,
  IconButton,
  Input,
  Stack,
  Textarea,
  Typography,
} from "@launchpad/ui";

import type { PlacementPreview } from "@launchpad/core";

import {
  createEmptyCreative,
  type CreativeFormState,
  type SingleCreative,
} from "./state";

type CreativeGenerationStepProps = {
  creatives: CreativeFormState;
  previews: PlacementPreview[];
  error: string | null;
  isLoading: boolean;
  onGenerate: () => Promise<void>;
  onCreativesChange: (creatives: CreativeFormState) => void;
};

export function CreativeGenerationStep({
  creatives,
  previews,
  error,
  isLoading,
  onGenerate,
  onCreativesChange,
}: CreativeGenerationStepProps) {
  const updateCreative = (
    id: string,
    field: keyof SingleCreative,
    value: string,
  ) => {
    const updated = creatives.creatives.map((c) =>
      c.id === id ? { ...c, [field]: value } : c,
    );
    onCreativesChange({ creatives: updated });
  };

  const addCreative = () => {
    onCreativesChange({
      creatives: [...creatives.creatives, createEmptyCreative()],
    });
  };

  const removeCreative = (id: string) => {
    if (creatives.creatives.length <= 1) return;
    onCreativesChange({
      creatives: creatives.creatives.filter((c) => c.id !== id),
    });
  };

  const firstCreative = creatives.creatives[0];

  return (
    <Stack gap={8}>
      <div className="flex items-center justify-between">
        <div>
          <Typography variant="heading-3" className="mb-2">
            Ad Creatives
          </Typography>
          <Typography tone="muted">Generate or write your ad copy.</Typography>
        </div>
        <Button
          variant="primary"
          loading={isLoading}
          onClick={() => void onGenerate()}
          leadingIcon={
            <Icon size={18}>
              <path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364-.707-.707M6.343 6.343l-.707-.707m12.728 0-.707.707M6.343 17.657l-.707.707" />
              <circle cx="12" cy="12" r="4" />
            </Icon>
          }
        >
          AI Generate
        </Button>
      </div>

      <Grid minItemWidth="24rem">
        <Stack gap={6}>
          {creatives.creatives.map((creative, index) => (
            <Card key={creative.id} className="relative">
              <div className="mb-4 flex items-center justify-between">
                <Typography className="font-medium">
                  Creative {index + 1}
                </Typography>
                {creatives.creatives.length > 1 && (
                  <IconButton
                    variant="ghost"
                    size="sm"
                    onClick={() => removeCreative(creative.id)}
                    aria-label="Remove creative"
                    icon={
                      <Icon size={18}>
                        <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </Icon>
                    }
                  />
                )}
              </div>

              <Stack gap={4}>
                <Input
                  placeholder="Enter headline"
                  value={creative.headline}
                  onChange={(e) =>
                    updateCreative(creative.id, "headline", e.target.value)
                  }
                />
                <Input
                  placeholder="Enter description"
                  value={creative.description}
                  onChange={(e) =>
                    updateCreative(creative.id, "description", e.target.value)
                  }
                />
                <Textarea
                  placeholder="Enter body text"
                  value={creative.body}
                  onChange={(e) =>
                    updateCreative(creative.id, "body", e.target.value)
                  }
                  rows={3}
                />
                <Input
                  placeholder="Enter CTA (e.g., Try It Free!)"
                  value={creative.cta}
                  onChange={(e) =>
                    updateCreative(creative.id, "cta", e.target.value)
                  }
                />
              </Stack>
            </Card>
          ))}

          <Button variant="ghost" onClick={addCreative} className="w-full">
            + Add Creative
          </Button>
        </Stack>

        <AdPreview
          headline={firstCreative?.headline || ""}
          description={firstCreative?.description || ""}
        />
      </Grid>
    </Stack>
  );
}
