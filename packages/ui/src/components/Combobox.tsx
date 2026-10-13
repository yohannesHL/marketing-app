import * as React from "react";

import { cx } from "../utils";
import { FieldGroup } from "./FieldGroup";
import { type BaseFieldProps } from "./internal";
import { type SelectOption } from "./Select";

export interface ComboboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size" | "list">, BaseFieldProps {
  options: SelectOption[];
}

export const Combobox = React.forwardRef<HTMLInputElement, ComboboxProps>(function Combobox(
  { label, hint, description, error, required, controlSize = "md", options, className, id, ...props },
  ref,
) {
  const generatedId = React.useId();
  const fieldId = id ?? generatedId;
  const listId = `${fieldId}-options`;

  return (
    <FieldGroup description={description} error={error} hint={hint} htmlFor={fieldId} label={label} required={required}>
      <input
        ref={ref}
        className={cx(
          "input input-bordered w-full bg-base-100",
          controlSize === "sm" && "input-sm",
          controlSize === "lg" && "input-lg",
          Boolean(error) && "input-error",
          className,
        )}
        id={fieldId}
        list={listId}
        {...props}
      />
      <datalist id={listId}>
        {options.map((option) => (
          <option key={option.value} value={option.label} />
        ))}
      </datalist>
    </FieldGroup>
  );
});
