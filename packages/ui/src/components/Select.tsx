import * as React from "react";

import { cx } from "../utils";
import { FieldGroup } from "./FieldGroup";
import { type BaseFieldProps } from "./internal";

export interface SelectOption {
  label: string;
  value: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "size">, BaseFieldProps {
  options: SelectOption[];
  placeholder?: string;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, description, error, required, controlSize = "md", options, placeholder, className, id, ...props },
  ref,
) {
  const generatedId = React.useId();
  const fieldId = id ?? generatedId;

  return (
    <FieldGroup description={description} error={error} hint={hint} htmlFor={fieldId} label={label} required={required}>
      <select
        ref={ref}
        className={cx(
          "select select-bordered w-full bg-base-100",
          controlSize === "sm" && "select-sm",
          controlSize === "lg" && "select-lg",
          Boolean(error) && "select-error",
          className,
        )}
        id={fieldId}
        {...props}
      >
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option disabled={option.disabled} key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldGroup>
  );
});
