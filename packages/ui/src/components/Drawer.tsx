import * as React from "react";

import { cx } from "../utils";

export interface DrawerProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  open: boolean;
  title: React.ReactNode;
  description?: React.ReactNode;
  side?: "left" | "right";
  onOpenChange?: (open: boolean) => void;
}

export function Drawer({ open, title, description, side = "right", onOpenChange, className, children, ...props }: DrawerProps) {
  if (!open) {
    return null;
  }

  return (
    <div className={cx("fixed inset-0 z-50 flex bg-neutral/40", side === "right" ? "justify-end" : "justify-start", className)} {...props}>
      <button aria-label="Close drawer" className="flex-1" onClick={() => onOpenChange?.(false)} type="button" />
      <aside className="flex h-full w-full max-w-md flex-col gap-4 border-l border-base-300 bg-base-100 p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-2xl font-semibold">{title}</h3>
            {description ? <p className="mt-2 text-sm text-base-content/70">{description}</p> : null}
          </div>
          <button className="btn btn-ghost btn-sm btn-circle" onClick={() => onOpenChange?.(false)} type="button">
            ✕
          </button>
        </div>
        <div className="grid gap-4">{children}</div>
      </aside>
    </div>
  );
}
