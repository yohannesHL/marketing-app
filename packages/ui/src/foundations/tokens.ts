import { brandPalettes, type BrandName } from "./brands";
import { themeDefinitions, type ThemeName } from "./themes";

export interface DesignTokens {
  themeId: string;
  backgroundCanvas: string;
  backgroundMuted: string;
  surfaceBase: string;
  surfaceRaised: string;
  surfaceOverlay: string;
  textPrimary: string;
  textMuted: string;
  brandPrimary: string;
  brandAccent: string;
  borderSubtle: string;
  borderStrong: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
}

export function resolveThemeId(themeName: ThemeName, brandName: BrandName): string {
  return `${brandName}-${themeName}`;
}

export function resolveDesignTokens(themeName: ThemeName, brandName: BrandName): DesignTokens {
  const theme = themeDefinitions[themeName];
  const brand = brandPalettes[brandName];

  return {
    themeId: resolveThemeId(themeName, brandName),
    backgroundCanvas: theme.background,
    backgroundMuted: theme.backgroundMuted,
    surfaceBase: theme.surface,
    surfaceRaised: theme.surfaceRaised,
    surfaceOverlay: theme.surfaceOverlay,
    textPrimary: theme.text,
    textMuted: theme.textMuted,
    brandPrimary: brand.primary["500"],
    brandAccent: brand.accent["500"],
    borderSubtle: theme.border,
    borderStrong: theme.borderStrong,
    success: theme.success,
    warning: theme.warning,
    danger: theme.danger,
    info: theme.info,
  };
}
