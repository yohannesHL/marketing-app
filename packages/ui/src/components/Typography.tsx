import * as React from "react";

import { cx } from "../utils";
import { toneClasses, typographyVariants, type TypographyTone, type TypographyVariant } from "./internal";

export interface TypographyProps extends React.HTMLAttributes<HTMLElement> {
  as?: React.ElementType;
  variant?: TypographyVariant;
  tone?: TypographyTone;
}

export function Typography({
  as: Component = "p",
  variant = "body",
  tone = "default",
  className,
  ...props
}: TypographyProps) {
  return React.createElement(Component, {
    className: cx(typographyVariants[variant], toneClasses[tone], className),
    ...props,
  });
}
