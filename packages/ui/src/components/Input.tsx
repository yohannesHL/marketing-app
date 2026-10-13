import * as React from "react";

import { cx } from "../utils";
import { FieldGroup } from "./FieldGroup";
import { FieldChrome, type BaseFieldProps } from "./internal";

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size">, BaseFieldProps {}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, description, error, required, controlSize = "md", leadingAdornment, trailingAdornment, className, id, ...props },
  ref,
) {
  const generatedId = React.useId();
  const fieldId = id ?? generatedId;

  return (
    <FieldGroup description={description} error={error} hint={hint} htmlFor={fieldId} label={label} required={required}>
      <FieldChrome
        className={cx(
          controlSize === "sm" && "min-h-10",
          controlSize === "md" && "min-h-12",
          controlSize === "lg" && "min-h-14",
          Boolean(error) && "border-error",
          className,
        )}
        leadingAdornment={leadingAdornment}
        trailingAdornment={trailingAdornment}
      >
        <input
          ref={ref}
          className={cx(
            "input w-full border-0 bg-transparent px-0 focus:outline-none",
            controlSize === "sm" && "input-sm",
            controlSize === "lg" && "input-lg",
          )}
          id={fieldId}
          {...props}
        />
      </FieldChrome>
    </FieldGroup>
  );
});
