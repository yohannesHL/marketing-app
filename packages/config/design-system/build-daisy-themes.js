const brandPalettes = require("./brands.json");
const themeDefinitions = require("./themes.json");

function resolveThemeTokens(theme, brand) {
  return {
    primary: brand.primary[500],
    "primary-content": "#ffffff",
    secondary: brand.accent[500],
    "secondary-content": "#ffffff",
    accent: brand.accent[400],
    "accent-content": theme.text,
    neutral: theme.surfaceRaised,
    "neutral-content": theme.text,
    "base-100": theme.surface,
    "base-200": theme.backgroundMuted,
    "base-300": theme.border,
    "base-content": theme.text,
    info: theme.info,
    success: theme.success,
    warning: theme.warning,
    error: theme.danger,
    "--rounded-box": "0.5rem",
    "--rounded-btn": "0.375rem",
    "--rounded-badge": "0.25rem",
    "--tab-radius": "0.375rem",
    "--animation-btn": "0.18s",
    "--animation-input": "0.18s",
    "--btn-focus-scale": "0.99",
    "--border-btn": "1px",
    "--depth": "0",
    "--noise": "0"
  };
}

function buildDaisyThemes() {
  return Object.entries(brandPalettes).flatMap(([brandName, brand]) =>
    Object.entries(themeDefinitions).map(([themeName, theme]) => ({
      [`${brandName}-${themeName}`]: resolveThemeTokens(theme, brand)
    })),
  );
}

module.exports = {
  brandPalettes,
  themeDefinitions,
  buildDaisyThemes,
  resolveThemeTokens,
};
