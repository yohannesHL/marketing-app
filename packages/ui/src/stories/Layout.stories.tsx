import type { Meta, StoryObj } from "@storybook/react";
import * as React from "react";

import {
  AdPreview,
  Card,
  Container,
  Divider,
  Grid,
  Inline,
  SelectableCard,
  Stack,
  Surface,
  Tag,
  TagGroup,
  Typography,
} from "../index";

const meta = {
  title: "Foundation/Layout",
  tags: ["autodocs"],
} satisfies Meta;

export default meta;

export const Composition: StoryObj<typeof meta> = {
  render: () => (
    <Container className="py-6">
      <Stack gap={6}>
        <Surface>
          <Typography variant="heading-3">Reusable surface</Typography>
        </Surface>
        <Inline justify="space-between">
          <Typography variant="heading-3">Inline layout</Typography>
          <Typography tone="muted">Aligned metadata</Typography>
        </Inline>
        <Divider label="Grid composition" />
        <Grid minItemWidth="16rem">
          <Card title="Pipeline visibility">
            Use cards for narrative or product content blocks.
          </Card>
          <Card title="Token-driven spacing">
            Grid and stack primitives keep composition consistent.
          </Card>
          <Card title="Responsive containers">
            Shared shells reduce app-specific layout code.
          </Card>
        </Grid>
      </Stack>
    </Container>
  ),
};

export const SelectableCards: StoryObj<typeof meta> = {
  render: function SelectableCardsStory() {
    const [selected, setSelected] = React.useState<string | null>("traffic");

    return (
      <Container className="py-6">
        <Stack gap={6}>
          <Typography variant="heading-3">Campaign Goals</Typography>
          <Grid minItemWidth="16rem">
            <SelectableCard
              icon="🚀"
              title="Product Launch"
              description="Create buzz around your new product"
              selected={selected === "launch"}
              recommendation="Recommended: Multi-platform launch with video content"
              onSelect={() => setSelected("launch")}
            />
            <SelectableCard
              icon="🌟"
              title="Brand Awareness"
              description="Get your brand in front of the right people"
              selected={selected === "awareness"}
              recommendation="Recommended: Display and social campaigns"
              onSelect={() => setSelected("awareness")}
            />
            <SelectableCard
              icon="🎯"
              title="Lead Generation"
              description="Capture leads and grow your pipeline"
              selected={selected === "leads"}
              recommendation="Recommended: LinkedIn and Google lead forms"
              onSelect={() => setSelected("leads")}
            />
            <SelectableCard
              icon="🌐"
              title="Website Traffic"
              description="Drive visitors to your website"
              selected={selected === "traffic"}
              recommendation="Recommended: CPC-optimized campaigns across platforms"
              onSelect={() => setSelected("traffic")}
            />
          </Grid>
        </Stack>
      </Container>
    );
  },
};

export const Tags: StoryObj<typeof meta> = {
  render: function TagsStory() {
    const [selectedTags, setSelectedTags] = React.useState<string[]>([
      "Technology",
      "Marketing",
    ]);

    const toggleTag = (tag: string) => {
      setSelectedTags((prev) =>
        prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
      );
    };

    return (
      <Container className="py-6">
        <Stack gap={6}>
          <Typography variant="heading-3">Interest Tags</Typography>
          <TagGroup label="Select interests">
            {[
              "Technology",
              "SaaS",
              "Marketing",
              "E-commerce",
              "Finance",
              "Health",
              "Education",
              "Design",
            ].map((tag) => (
              <Tag
                key={tag}
                selected={selectedTags.includes(tag)}
                onToggle={() => toggleTag(tag)}
              >
                {tag}
              </Tag>
            ))}
          </TagGroup>
          <Typography tone="muted">
            Selected: {selectedTags.join(", ") || "None"}
          </Typography>
        </Stack>
      </Container>
    );
  },
};

export const AdPreviewComponent: StoryObj<typeof meta> = {
  render: () => (
    <Container className="py-6">
      <Stack gap={6}>
        <Typography variant="heading-3">Ad Preview</Typography>
        <Grid minItemWidth="20rem">
          <AdPreview
            headline="Speed Up Your Commute!"
            description="Discover faster routes now."
          />
          <AdPreview
            headline="Unlock Better Roads!"
            description="Navigate traffic like a pro."
          />
        </Grid>
      </Stack>
    </Container>
  ),
};
