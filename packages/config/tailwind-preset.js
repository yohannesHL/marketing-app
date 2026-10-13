const daisyui = require("daisyui");
const { buildDaisyThemes } = require("./design-system/build-daisy-themes");

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [],
  theme: {
    extend: {
      boxShadow: {
        soft: "0 18px 40px -24px rgba(15, 23, 42, 0.18)",
        strong: "0 32px 80px -48px rgba(15, 23, 42, 0.24)",
      },
      maxWidth: {
        container: "72rem",
      },
      fontSize: {
        overline: ["0.75rem", { lineHeight: "1rem", letterSpacing: "0.12em", fontWeight: "700" }],
      },
      spacing: {
        18: "4.5rem",
      },
    },
  },
  daisyui: {
    styled: true,
    themes: buildDaisyThemes(),
    darkTheme: "launchpad-dark",
    base: true,
    utils: true,
    logs: false,
  },
  plugins: [daisyui],
};
