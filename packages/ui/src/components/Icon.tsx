import * as React from "react";

import { cx } from "../utils";

export interface IconProps extends React.SVGAttributes<SVGSVGElement> {
  size?: number;
  title?: string;
}

export function Icon({ size = 20, title, children, className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden={title ? undefined : true}
      className={cx("shrink-0", className)}
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.75}
      viewBox="0 0 24 24"
      width={size}
      {...props}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}
