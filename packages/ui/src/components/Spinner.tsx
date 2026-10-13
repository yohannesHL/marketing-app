import * as React from "react";

import { cx } from "../utils";

export interface SpinnerProps extends React.HTMLAttributes<HTMLSpanElement> {
  size?: "xs" | "sm" | "md" | "lg";
}

export function Spinner({ size = "md", className, ...props }: SpinnerProps) {
  return (
    <span
      className={cx(
        "loading loading-spinner text-primary",
        size === "xs" && "loading-xs",
        size === "sm" && "loading-sm",
        size === "lg" && "loading-lg",
        className,
      )}
      {...props}
    />
  );
}
