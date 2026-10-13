import type { Meta, StoryObj } from "@storybook/react";

import { Accordion, Breadcrumbs, Pagination, Stack, Stepper, Tabs } from "../index";

const meta = {
  title: "Foundation/Navigation",
  tags: ["autodocs"],
} satisfies Meta;

export default meta;

export const NavigationPatterns: StoryObj<typeof meta> = {
  render: () => (
    <Stack className="p-6" gap={6}>
      <Breadcrumbs items={[{ label: "Home", href: "#" }, { label: "Campaigns", href: "#" }, { label: "Launch review" }]} />
      <Stepper
        currentStep={1}
        steps={[
          { id: "audience", title: "Audience", description: "Define the launch cohort." },
          { id: "creative", title: "Creative", description: "Approve messaging and assets." },
          { id: "review", title: "Review", description: "Finalize timing and channels." },
        ]}
      />
      <Tabs
        items={[
          { id: "overview", label: "Overview", content: <p>Overview panel content.</p> },
          { id: "assets", label: "Assets", content: <p>Assets panel content.</p> },
          { id: "metrics", label: "Metrics", content: <p>Metrics panel content.</p> },
        ]}
      />
      <Accordion
        defaultOpenIds={["one"]}
        items={[
          { id: "one", title: "What ships in v1?", content: <p>The complete base component inventory plus Storybook theming.</p> },
          { id: "two", title: "How do themes switch?", content: <p>Storybook globals toggle DaisyUI theme ids generated from shared tokens.</p> },
        ]}
      />
      <Pagination page={2} totalPages={5} />
    </Stack>
  ),
};
