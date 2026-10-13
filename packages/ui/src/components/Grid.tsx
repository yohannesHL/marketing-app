import * as React from "react";

import { cx } from "../utils";

export interface GridProps extends React.HTMLAttributes<HTMLDivElement> {
  columns?: number;
  gap?: number;
  minItemWidth?: string;
}

export function Grid({ columns = 3, gap = 4, minItemWidth, className, style, ...props }: GridProps) {
  return (
    <div
      className={cx("grid", className)}
      style={{
        gap: `${gap * 0.25}rem`,
        gridTemplateColumns: minItemWidth
          ? `repeat(auto-fit, minmax(${minItemWidth}, 1fr))`
          : `repeat(${columns}, minmax(0, 1fr))`,
        ...style,
      }}
      {...props}
    />
  );
}
