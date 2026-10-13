import brandPalettesJson from "../../../config/design-system/brands.json";

export const colorScaleSteps = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900] as const;

export type ColorScaleStep = `${(typeof colorScaleSteps)[number]}`;
export type ColorScale = Record<ColorScaleStep, string>;

export interface BrandPalette {
  name: string;
  primary: ColorScale;
  accent: ColorScale;
}

export const brandPalettes = brandPalettesJson as Record<string, BrandPalette>;
export type BrandName = keyof typeof brandPalettesJson;
export const supportedBrands = Object.keys(brandPalettes) as BrandName[];

function validateColorScale(label: string, scale: ColorScale): void {
  for (const step of colorScaleSteps) {
    if (!scale[String(step) as ColorScaleStep]) {
      throw new Error(`Brand color scale \"${label}\" is missing the ${step} step.`);
    }
  }
}

export function validateBrandPalettes(): void {
  for (const [name, palette] of Object.entries(brandPalettes)) {
    if (!palette.name) {
      throw new Error(`Brand palette \"${name}\" must include a display name.`);
    }

    validateColorScale(`${name}.primary`, palette.primary);
    validateColorScale(`${name}.accent`, palette.accent);
  }
}

validateBrandPalettes();
