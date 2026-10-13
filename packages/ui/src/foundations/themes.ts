import themeDefinitionsJson from "../../../config/design-system/themes.json";

export interface ThemeDefinition {
  name: string;
  background: string;
  backgroundMuted: string;
  surface: string;
  surfaceRaised: string;
  surfaceOverlay: string;
  text: string;
  textMuted: string;
  border: string;
  borderStrong: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
  overlay: string;
  shadow: string;
}

export const themeDefinitions = themeDefinitionsJson as Record<string, ThemeDefinition>;
export type ThemeName = keyof typeof themeDefinitionsJson;
export const supportedThemes = Object.keys(themeDefinitions) as ThemeName[];

export function validateThemeDefinitions(): void {
  const requiredFields: Array<keyof ThemeDefinition> = [
    "name",
    "background",
    "backgroundMuted",
    "surface",
    "surfaceRaised",
    "surfaceOverlay",
    "text",
    "textMuted",
    "border",
    "borderStrong",
    "success",
    "warning",
    "danger",
    "info",
    "overlay",
    "shadow",
  ];

  for (const [name, theme] of Object.entries(themeDefinitions)) {
    for (const field of requiredFields) {
      if (!theme[field]) {
        throw new Error(`Theme \"${name}\" is missing the required \"${field}\" token.`);
      }
    }
  }
}

validateThemeDefinitions();
