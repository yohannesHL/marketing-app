import type { Meta, StoryObj } from "@storybook/react";

import { Checkbox, Combobox, FieldGroup, Input, RadioGroup, Select, Stack, Switch, Textarea } from "../index";

const meta = {
  title: "Foundation/Fields",
  tags: ["autodocs"],
} satisfies Meta;

export default meta;

const options = [
  { label: "Product marketing", value: "product-marketing" },
  { label: "Demand generation", value: "demand-generation" },
  { label: "Lifecycle", value: "lifecycle" },
];

export const Controls: StoryObj<typeof meta> = {
  render: () => (
    <Stack className="max-w-2xl p-6" gap={5}>
      <FieldGroup description="Shared wrapper for composed controls." hint="Optional" label="Field group">
        <div className="rounded-box border border-dashed border-base-300 p-4 text-sm text-base-content/70">Place custom controls here.</div>
      </FieldGroup>

      <Input label="Campaign name" placeholder="Q3 expansion launch" hint="Required" required />
      <Input
        label="Budget"
        leadingAdornment="$"
        trailingAdornment="USD"
        placeholder="25,000"
      />
      <Textarea label="Summary" placeholder="Describe the launch narrative and audience." />
      <Select label="Team" options={options} placeholder="Choose a team" />
      <Combobox label="Owner" options={options} placeholder="Search teammates" />
      <Checkbox label="Enable launch notifications" description="Send a rollout note to stakeholders." defaultChecked />
      <RadioGroup
        defaultValue="guided"
        items={[
          { label: "Guided setup", value: "guided", description: "Recommended for new campaigns." },
          { label: "Advanced setup", value: "advanced", description: "Customize audience and pacing." },
        ]}
        label="Setup mode"
      />
      <Switch label="Dark launch" description="Roll out privately before the public launch." />
    </Stack>
  ),
};
