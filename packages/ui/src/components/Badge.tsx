import * as React from "react";

import { cx } from "../utils";
import { getBadgeClassName, type Tone } from "./internal";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
}

export function Badge({ tone = "neutral", className, ...props }: BadgeProps) {
  return <span className={cx("badge border-0 font-semibold", getBadgeClassName(tone), className)} {...props} />;
}
