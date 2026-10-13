import * as React from "react";

import { cx } from "../utils";

export interface StackProps extends React.HTMLAttributes<HTMLDivElement> {
  gap?: number;
}

export function Stack({ gap = 4, className, style, ...props }: StackProps) {
  return <div className={cx("grid", className)} style={{ gap: `${gap * 0.25}rem`, ...style }} {...props} />;
}
