import * as React from "react";

import { cx } from "../utils";

export interface ModalProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  open: boolean;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  onOpenChange?: (open: boolean) => void;
}

export function Modal({ open, title, description, actions, onOpenChange, className, children, ...props }: ModalProps) {
  if (!open) {
    return null;
  }

  return (
    <div className={cx("modal modal-open", className)} {...props}>
      <div className="modal-box max-w-2xl border border-base-300 bg-base-100">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-2xl font-semibold">{title}</h3>
            {description ? <p className="mt-2 text-sm text-base-content/70">{description}</p> : null}
          </div>
          <button className="btn btn-ghost btn-sm btn-circle" onClick={() => onOpenChange?.(false)} type="button">
            ✕
          </button>
        </div>
        <div className="grid gap-4">{children}</div>
        {actions ? <div className="modal-action">{actions}</div> : null}
      </div>
      <button aria-label="Close modal" className="modal-backdrop" onClick={() => onOpenChange?.(false)} type="button">
        close
      </button>
    </div>
  );
}
