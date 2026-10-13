import * as React from "react";

import { cx } from "../utils";

export interface FieldGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  label?: React.ReactNode;
  description?: React.ReactNode;
  error?: React.ReactNode;
  hint?: React.ReactNode;
  required?: boolean;
  htmlFor?: string;
}

export function FieldGroup({
  label,
  description,
  error,
  hint,
  required,
  htmlFor,
  className,
  children,
  ...props
}: FieldGroupProps) {
  return (
    <div className={cx("form-control w-full gap-2", className)} {...props}>
      {label ? (
        <label className="label pb-0" htmlFor={htmlFor}>
          <span className="label-text text-sm font-semibold text-base-content">
            {label}
            {required ? <span className="ml-1 text-error">*</span> : null}
          </span>
          {hint ? <span className="label-text-alt text-base-content/70">{hint}</span> : null}
        </label>
      ) : null}
      {description ? <p className="text-sm text-base-content/70">{description}</p> : null}
      {children}
      {error ? <p className="text-sm text-error">{error}</p> : null}
    </div>
  );
}
