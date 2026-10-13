import * as React from "react";

import { cx } from "../utils";

export interface VisuallyHiddenProps extends React.HTMLAttributes<HTMLSpanElement> {}

export function VisuallyHidden({ className, ...props }: VisuallyHiddenProps) {
  return <span className={cx("sr-only", className)} {...props} />;
}
