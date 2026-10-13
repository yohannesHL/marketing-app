import * as React from "react";

import { cx } from "../utils";

export interface TagProps extends React.HTMLAttributes<HTMLButtonElement> {
  selected?: boolean;
  onToggle?: () => void;
}

export function Tag({
  selected = false,
  onToggle,
  className,
  children,
  ...props
}: TagProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cx(
        "inline-flex items-center rounded-full border px-4 py-1.5 text-sm font-medium transition-all",
        "hover:border-primary/40",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
        selected
          ? "border-primary bg-primary/10 text-primary"
          : "border-base-300 bg-base-100 text-base-content/80",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export interface TagGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  label?: string;
}

export function TagGroup({
  label,
  className,
  children,
  ...props
}: TagGroupProps) {
  return (
    <div className={cx("flex flex-col gap-2", className)} {...props}>
      {label && (
        <span className="text-sm font-medium text-base-content">{label}</span>
      )}
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}
