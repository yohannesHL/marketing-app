import * as React from "react";

import { cx } from "../utils";

export interface SelectableCardProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "title"
> {
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  selected?: boolean;
  recommendation?: React.ReactNode;
  meta?: React.ReactNode;
  onSelect?: () => void;
}

export function SelectableCard({
  title,
  description,
  icon,
  selected = false,
  recommendation,
  meta,
  onSelect,
  className,
  ...props
}: SelectableCardProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect?.();
        }
      }}
      className={cx(
        "group cursor-pointer rounded-xl border-2 bg-base-100 p-5 transition-all",
        "hover:border-primary/40 hover:shadow-md",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
        selected ? "border-primary shadow-md" : "border-base-300",
        className,
      )}
      {...props}
    >
      <div className="flex flex-col gap-3">
        {icon && <div className="text-3xl">{icon}</div>}
        <div className="flex flex-col gap-1">
          <h4 className="font-semibold text-base-content">{title}</h4>
          {description && (
            <p className="text-sm text-base-content/70">{description}</p>
          )}
        </div>
        {meta && <div className="text-xs text-base-content/60">{meta}</div>}
        {selected && recommendation && (
          <div className="mt-2 flex items-start gap-2 rounded-lg bg-primary/10 px-3 py-2 text-sm text-primary">
            <svg
              className="mt-0.5 h-4 w-4 shrink-0"
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2 2a1 1 0 001.414-1.414L11 9.586V6z" />
            </svg>
            <span>{recommendation}</span>
          </div>
        )}
      </div>
    </div>
  );
}
