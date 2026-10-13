import * as React from "react";

import { cx } from "../utils";
import { FieldGroup } from "./FieldGroup";
import { type ControlSize } from "./internal";

export interface SwitchProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "size"> {
  label: React.ReactNode;
  description?: React.ReactNode;
  error?: React.ReactNode;
  controlSize?: ControlSize;
}

export const Switch = React.forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  { label, description, error, controlSize = "md", className, id, ...props },
  ref,
) {
  const generatedId = React.useId();
  const fieldId = id ?? generatedId;

  return (
    <FieldGroup error={error} htmlFor={fieldId}>
      <label className="label cursor-pointer items-start justify-start gap-3" htmlFor={fieldId}>
        <input
          ref={ref}
          className={cx(
            "toggle toggle-primary mt-1",
            controlSize === "sm" && "toggle-sm",
            controlSize === "lg" && "toggle-lg",
            className,
          )}
          id={fieldId}
          type="checkbox"
          {...props}
        />
        <span className="grid gap-1">
          <span className="label-text text-base font-medium text-base-content">{label}</span>
          {description ? <span className="text-sm text-base-content/70">{description}</span> : null}
        </span>
      </label>
    </FieldGroup>
  );
});
