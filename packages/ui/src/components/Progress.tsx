import * as React from "react";

import { cx } from "../utils";

export interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number;
  max?: number;
  indeterminate?: boolean;
  label?: React.ReactNode;
}

export function Progress({ value = 0, max = 100, indeterminate = false, label, className, ...props }: ProgressProps) {
  if (indeterminate) {
    return (
      <div className="grid gap-2" {...props}>
        {label ? <span className="text-sm font-medium text-base-content/70">{label}</span> : null}
        <div className={cx("h-3 w-full overflow-hidden rounded-full bg-base-300", className)}>
          <div className="h-full w-2/5 animate-pulse rounded-full bg-primary" />
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-2" {...props}>
      {label ? <span className="text-sm font-medium text-base-content/70">{label}</span> : null}
      <progress className={cx("progress progress-primary w-full", className)} max={max} value={value} />
    </div>
  );
}
