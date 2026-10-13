import type { Preview } from "@storybook/react";
import * as React from "react";

import "../src/storybook.css";

import { LaunchpadProvider, supportedBrands, supportedThemes } from "../src";

const preview: Preview = {
  globalTypes: {
    theme: {
      name: "Theme",
      defaultValue: supportedThemes[0],
      toolbar: {
        icon: "mirror",
        items: supportedThemes,
      },
    },
    brand: {
      name: "Brand",
      defaultValue: supportedBrands[0],
      toolbar: {
        icon: "paintbrush",
        items: supportedBrands,
      },
    },
  },
  decorators: [
    (Story, context) => (
      <LaunchpadProvider brand={context.globals.brand} theme={context.globals.theme}>
        <div className="min-h-screen bg-base-200 p-6 text-base-content">
          <Story />
        </div>
      </LaunchpadProvider>
    ),
  ],
  parameters: {
    layout: "fullscreen",
    controls: { expanded: true },
  },
};

export default preview;
