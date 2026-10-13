import * as React from "react";

import { cx } from "../utils";

export interface TooltipProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "content"> {
  content: string;
  children: React.ReactNode;
  position?: "top" | "bottom" | "left" | "right";
}

export function Tooltip({ content, position = "top", className, children, ...props }: TooltipProps) {
  return (
    <div
      className={cx(
        "tooltip",
        position === "bottom" && "tooltip-bottom",
        position === "left" && "tooltip-left",
        position === "right" && "tooltip-right",
        className,
      )}
      data-tip={content}
      {...props}
    >
      {children}
    </div>
  );
}
