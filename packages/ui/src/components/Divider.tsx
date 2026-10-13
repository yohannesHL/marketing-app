import * as React from "react";

import { cx } from "../utils";

export interface DividerProps extends React.HTMLAttributes<HTMLDivElement> {
  orientation?: "horizontal" | "vertical";
  label?: React.ReactNode;
}

export function Divider({ orientation = "horizontal", label, className, ...props }: DividerProps) {
  return (
    <div className={cx("divider", orientation === "vertical" && "divider-horizontal", className)} {...props}>
      {label}
    </div>
  );
}
