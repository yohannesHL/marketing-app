import type { Meta, StoryObj } from "@storybook/react";

import { Alert, Button, EmptyState, Progress, Skeleton, Stack, Toast } from "../index";

const meta = {
  title: "Foundation/Feedback",
  tags: ["autodocs"],
} satisfies Meta;

export default meta;

export const StatusStates: StoryObj<typeof meta> = {
  render: () => (
    <Stack className="p-6" gap={6}>
      <Alert title="Campaign ready" tone="success">
        All primary assets passed review and the launch can be scheduled.
      </Alert>
      <Toast title="Saved" tone="info">
        Your brand theme changes were published to Storybook preview.
      </Toast>
      <Progress label="Rollout progress" value={64} />
      <Progress indeterminate label="Syncing design tokens" />
      <Stack gap={3}>
        <Skeleton className="w-48" />
        <Skeleton variant="card" />
      </Stack>
      <EmptyState
        title="No launch briefs yet"
        description="Create your first brief to align product, design, and revenue teams around the release story."
        action={<Button>Create brief</Button>}
      />
    </Stack>
  ),
};
