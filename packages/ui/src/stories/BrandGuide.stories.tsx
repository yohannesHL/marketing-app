import type { Meta, StoryObj } from "@storybook/react";

import { Badge, Card, Inline, Stack, TextLink, Typography } from "../index";

const meta = {
  title: "Foundation/Brand Guide",
  tags: ["autodocs"],
  render: () => (
    <Stack className="p-6" gap={6}>
      <Stack gap={2}>
        <Typography as="span" variant="overline">Launchpad UI</Typography>
        <Typography as="h1" variant="heading-1">Modern startup polish with product-grade clarity.</Typography>
        <Typography className="max-w-3xl" tone="muted">
          The foundation pairs a dedicated brand palette with semantic theme tokens so the system can evolve visually without rewriting component behavior.
        </Typography>
      </Stack>

      <Card title="Typography and emphasis" eyebrow="Type system">
        <Stack gap={3}>
          <Typography as="h2" variant="heading-2">Headlines stay bold and decisive.</Typography>
          <Typography>Body copy is tuned for readable interfaces and future editorial sections.</Typography>
          <Typography variant="caption">Caption text handles supporting context, metadata, and footnotes.</Typography>
          <Inline>
            <Badge tone="primary">Primary brand</Badge>
            <Badge tone="success">Semantic success</Badge>
            <Badge tone="warning">Semantic warning</Badge>
          </Inline>
          <TextLink href="#" standalone>
            Read the style guide
          </TextLink>
        </Stack>
      </Card>
    </Stack>
  ),
} satisfies Meta;

export default meta;
export const Overview: StoryObj<typeof meta> = {};
