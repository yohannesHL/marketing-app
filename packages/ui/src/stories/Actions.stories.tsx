import type { Meta, StoryObj } from "@storybook/react";

import { Button, ButtonGroup, Icon, IconButton, Inline, Spinner, Stack } from "../index";

const meta = {
  title: "Foundation/Actions",
  tags: ["autodocs"],
} satisfies Meta;

export default meta;

export const Buttons: StoryObj<typeof meta> = {
  render: () => (
    <Stack className="p-6" gap={6}>
      <Inline>
        <Button>Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">Destructive</Button>
        <Button loading>Loading</Button>
      </Inline>

      <ButtonGroup>
        <Button variant="secondary">Cancel</Button>
        <Button>Save changes</Button>
        <Button variant="ghost">Preview</Button>
      </ButtonGroup>

      <Inline>
        <IconButton
          aria-label="Open notifications"
          icon={<Icon><path d="M12 5a4 4 0 0 1 4 4v2.5l1.25 2.5H6.75L8 11.5V9a4 4 0 0 1 4-4Z" /><path d="M10 18a2 2 0 0 0 4 0" /></Icon>}
          variant="secondary"
        />
        <Spinner />
      </Inline>
    </Stack>
  ),
};
