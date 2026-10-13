import * as React from "react";

import { cx } from "../utils";

export interface PopoverProps extends Omit<React.HTMLAttributes<HTMLDetailsElement>, "title" | "content"> {
  trigger: React.ReactNode;
  title?: React.ReactNode;
  content: React.ReactNode;
}

export function Popover({ trigger, title, content, className, ...props }: PopoverProps) {
  return (
    <details className={cx("dropdown", className)} {...props}>
      <summary className="list-none">{trigger}</summary>
      <div className="dropdown-content z-[1] mt-2 w-80 rounded-box border border-base-300 bg-base-100 p-4 shadow-soft">
        {title ? <h4 className="mb-2 font-semibold">{title}</h4> : null}
        <div className="text-sm text-base-content/70">{content}</div>
      </div>
    </details>
  );
}
