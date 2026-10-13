import type { Config } from "tailwindcss";
import configPreset from "../config/tailwind-preset";

const config: Config = {
  presets: [configPreset],
  content: ["./src/**/*.{ts,tsx}", "./.storybook/**/*.{ts,tsx}"],
};

export default config;
