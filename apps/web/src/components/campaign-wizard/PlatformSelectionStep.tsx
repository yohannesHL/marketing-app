"use client";

import {
  supportedPlatforms,
  type PlatformEstimateResponse,
  type SupportedPlatform,
} from "@launchpad/core";
import { Grid, SelectableCard, Stack, Typography } from "@launchpad/ui";

type PlatformInfo = {
  icon: string;
  name: string;
  reach: string;
  avgCpc: string;
};

const platformInfo: Record<SupportedPlatform, PlatformInfo> = {
  Meta: { icon: "📱", name: "Meta Ads", reach: "2.9B", avgCpc: "$0.97" },
  Google: { icon: "🔍", name: "Google Ads", reach: "8.5B", avgCpc: "$1.16" },
  LinkedIn: {
    icon: "💼",
    name: "LinkedIn Ads",
    reach: "900M",
    avgCpc: "$5.26",
  },
  TikTok: { icon: "🎵", name: "TikTok Ads", reach: "1.5B", avgCpc: "$1.00" },
  X: { icon: "✖️", name: "X Ads", reach: "550M", avgCpc: "$0.38" },
  Reddit: { icon: "🔴", name: "Reddit Ads", reach: "430M", avgCpc: "$0.75" },
};

// Add YouTube as supported but not in the type yet
const allPlatforms: Array<{ key: string; info: PlatformInfo }> = [
  ...supportedPlatforms.map((p) => ({ key: p, info: platformInfo[p] })),
  {
    key: "YouTube",
    info: { icon: "▶️", name: "YouTube Ads", reach: "2.5B", avgCpc: "$0.10" },
  },
];

type PlatformSelectionStepProps = {
  selectedPlatforms: SupportedPlatform[];
  estimate: PlatformEstimateResponse | null;
  error: string | null;
  isLoading: boolean;
  onTogglePlatform: (platform: SupportedPlatform, enabled: boolean) => void;
};

export function PlatformSelectionStep({
  selectedPlatforms,
  estimate,
  error,
  isLoading,
  onTogglePlatform,
}: PlatformSelectionStepProps) {
  return (
    <Stack gap={8}>
      <div>
        <Typography variant="heading-3" className="mb-2">
          Select Platforms
        </Typography>
        <Typography tone="muted">Choose where your ads will appear.</Typography>
      </div>

      <Grid minItemWidth="16rem">
        {supportedPlatforms.map((platform) => {
          const info = platformInfo[platform];
          const isSelected = selectedPlatforms.includes(platform);

          return (
            <SelectableCard
              key={platform}
              icon={<span className="text-2xl">{info.icon}</span>}
              title={info.name}
              selected={isSelected}
              meta={
                <span className="flex gap-3 text-base-content/60">
                  <span>Reach: {info.reach}</span>
                  <span>Avg CPC: {info.avgCpc}</span>
                </span>
              }
              onSelect={() => onTogglePlatform(platform, !isSelected)}
            />
          );
        })}
      </Grid>
    </Stack>
  );
}
