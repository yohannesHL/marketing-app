import * as React from "react";

import { cx } from "../utils";

export interface SurfaceProps extends React.HTMLAttributes<HTMLDivElement> {
  as?: React.ElementType;
  variant?: "flat" | "raised" | "sunken";
  padding?: "none" | "sm" | "md" | "lg";
}

export function Surface({ as: Component = "div", variant = "raised", padding = "md", className, ...props }: SurfaceProps) {
  return React.createElement(Component, {
    className: cx(
      "rounded-box border border-base-300",
      variant === "raised" && "bg-base-100 shadow-soft",
      variant === "flat" && "bg-transparent",
      variant === "sunken" && "bg-base-200",
      padding === "sm" && "p-4",
      padding === "md" && "p-6",
      padding === "lg" && "p-8",
      className,
    ),
    ...props,
  });
}
