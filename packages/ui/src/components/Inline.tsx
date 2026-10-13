import * as React from "react";

import { cx } from "../utils";

export interface InlineProps extends React.HTMLAttributes<HTMLDivElement> {
  gap?: number;
  align?: React.CSSProperties["alignItems"];
  justify?: React.CSSProperties["justifyContent"];
}

export function Inline({ gap = 3, align = "center", justify = "flex-start", className, style, ...props }: InlineProps) {
  return (
    <div
      className={cx("flex flex-wrap", className)}
      style={{ gap: `${gap * 0.25}rem`, alignItems: align, justifyContent: justify, ...style }}
      {...props}
    />
  );
}
