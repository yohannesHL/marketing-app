import * as React from "react";

import { cx } from "../utils";

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "text" | "avatar" | "card";
}

export function Skeleton({ variant = "text", className, ...props }: SkeletonProps) {
  return (
    <div
      className={cx(
        "skeleton",
        variant === "text" && "h-4 w-full rounded-full",
        variant === "avatar" && "h-12 w-12 rounded-full",
        variant === "card" && "h-40 w-full rounded-box",
        className,
      )}
      {...props}
    />
  );
}
