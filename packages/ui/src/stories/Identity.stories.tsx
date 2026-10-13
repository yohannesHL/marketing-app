import type { Meta, StoryObj } from "@storybook/react";

import { Avatar, Icon, Inline, Surface, Typography, VisuallyHidden } from "../index";

const meta = {
  title: "Foundation/Identity",
  tags: ["autodocs"],
} satisfies Meta;

export default meta;

export const IdentityPrimitives: StoryObj<typeof meta> = {
  render: () => (
    <Surface className="grid gap-6 p-6">
      <Inline>
        <Avatar name="Launchpad" size="sm" />
        <Avatar name="Product Ops" />
        <Avatar name="Revenue Team" size="lg" />
      </Inline>
      <Inline>
        <Icon title="Rocket">
          <path d="M14 4c3 0 6 3 6 6-3 0-6-3-6-6Z" />
          <path d="M10 14 4 20" />
          <path d="m7 13 4 4" />
        </Icon>
        <Typography>Icons inherit sizing and color from the surrounding context.</Typography>
      </Inline>
      <button className="btn btn-ghost w-fit">
        <VisuallyHidden>Open hidden utility example</VisuallyHidden>
        Hidden label utility
      </button>
    </Surface>
  ),
};
