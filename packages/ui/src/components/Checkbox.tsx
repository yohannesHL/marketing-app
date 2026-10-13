import * as React from "react";

import { cx } from "../utils";
import { FieldGroup } from "./FieldGroup";

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: React.ReactNode;
  description?: React.ReactNode;
  error?: React.ReactNode;
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, description, error, className, id, ...props },
  ref,
) {
  const generatedId = React.useId();
  const fieldId = id ?? generatedId;

  return (
    <FieldGroup error={error} htmlFor={fieldId}>
      <label className="label cursor-pointer items-start justify-start gap-3" htmlFor={fieldId}>
        <input ref={ref} className={cx("checkbox checkbox-primary mt-1", className)} id={fieldId} type="checkbox" {...props} />
        <span className="grid gap-1">
          <span className="label-text text-base font-medium text-base-content">{label}</span>
          {description ? <span className="text-sm text-base-content/70">{description}</span> : null}
        </span>
      </label>
    </FieldGroup>
  );
});
