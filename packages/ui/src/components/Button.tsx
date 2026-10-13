import * as React from "react";

import { cx } from "../utils";
import { buttonVariantClasses, type ButtonVariant, type ControlSize } from "./internal";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ControlSize;
  loading?: boolean;
  leadingIcon?: React.ReactNode;
  trailingIcon?: React.ReactNode;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "md",
    loading = false,
    leadingIcon,
    trailingIcon,
    className,
    children,
    disabled,
    type = "button",
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        "btn normal-case shadow-soft",
        buttonVariantClasses[variant],
        size === "sm" && "btn-sm",
        size === "lg" && "btn-lg",
        className,
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <span className="loading loading-spinner loading-sm" /> : leadingIcon}
      {children}
      {trailingIcon}
    </button>
  );
});
