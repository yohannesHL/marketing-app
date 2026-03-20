// packages/config/tailwind-preset.js
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [], // Content will be defined by the consuming app
  theme: {
    extend: {
      colors: {
        primary: "#3b82f6", // Example primary color
        secondary: "#6b7280", // Example secondary color
      },
    },
  },
  plugins: [],
};
