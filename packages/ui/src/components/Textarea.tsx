import * as React from "react";

import { cx } from "../utils";
import { FieldGroup } from "./FieldGroup";
import { type BaseFieldProps } from "./internal";

export interface TextareaProps extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "size">, BaseFieldProps {}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, description, error, required, controlSize = "md", className, id, ...props },
  ref,
) {
  const generatedId = React.useId();
  const fieldId = id ?? generatedId;

  return (
    <FieldGroup description={description} error={error} hint={hint} htmlFor={fieldId} label={label} required={required}>
      <textarea
        ref={ref}
        className={cx(
          "textarea textarea-bordered w-full bg-base-100",
          controlSize === "sm" && "textarea-sm",
          controlSize === "lg" && "textarea-lg",
          Boolean(error) && "textarea-error",
          className,
        )}
        id={fieldId}
        {...props}
      />
    </FieldGroup>
  );
});
