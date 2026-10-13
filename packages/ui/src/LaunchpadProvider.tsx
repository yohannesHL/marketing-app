import * as React from "react";

import { type BrandName } from "./foundations/brands";
import { resolveDesignTokens } from "./foundations/tokens";
import { type ThemeName } from "./foundations/themes";
import { cx } from "./utils";

export interface LaunchpadProviderProps {
  children: React.ReactNode;
  theme?: ThemeName;
  brand?: BrandName;
  className?: string;
}

export function LaunchpadProvider({
  children,
  theme = "light",
  brand = "launchpad",
  className,
}: LaunchpadProviderProps) {
  const tokens = resolveDesignTokens(theme, brand);

  return (
    <div
      className={cx("min-h-screen bg-base-200 text-base-content", className)}
      data-theme={tokens.themeId}
      style={{
        backgroundColor: tokens.backgroundCanvas,
        color: tokens.textPrimary,
      }}
    >
      {children}
    </div>
  );
}
