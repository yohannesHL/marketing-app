import * as React from "react";

import { cx } from "../utils";

export interface ContainerProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: "sm" | "md" | "lg" | "xl";
}

export function Container({ size = "lg", className, ...props }: ContainerProps) {
  return (
    <div
      className={cx(
        "mx-auto w-full px-6",
        size === "sm" && "max-w-3xl",
        size === "md" && "max-w-4xl",
        size === "lg" && "max-w-container",
        size === "xl" && "max-w-7xl",
        className,
      )}
      {...props}
    />
  );
}
