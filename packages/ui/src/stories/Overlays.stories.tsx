import type { Meta, StoryObj } from "@storybook/react";

import { Button, Drawer, Menu, Popover, Stack, Tooltip, Modal } from "../index";

const meta = {
  title: "Foundation/Overlays",
  tags: ["autodocs"],
} satisfies Meta;

export default meta;

export const OverlayPatterns: StoryObj<typeof meta> = {
  render: () => (
    <Stack className="p-6" gap={6}>
      <Menu label="Open menu" items={[{ label: "Rename" }, { label: "Duplicate" }, { label: "Archive", disabled: true }]} />
      <Popover
        trigger={<Button variant="secondary">View popover</Button>}
        title="Theme switching"
        content="Use the Storybook toolbar to preview all supported theme and brand combinations."
      />
      <Tooltip content="Helpful context for compact interfaces.">
        <Button variant="ghost">Hover for tooltip</Button>
      </Tooltip>
      <Modal
        open
        title="Confirm launch"
        description="This static story demonstrates the dialog surface and action layout."
        actions={<><Button variant="ghost">Cancel</Button><Button>Confirm</Button></>}
      >
        <p className="text-sm text-base-content/70">Dialogs keep focus on high-stakes tasks and confirmations.</p>
      </Modal>
      <Drawer open title="Launch settings" description="Use drawers for secondary tasks and mobile navigation.">
        <p className="text-sm text-base-content/70">This panel slides in with contextual controls.</p>
      </Drawer>
    </Stack>
  ),
};
