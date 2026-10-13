import * as React from "react";

import { cx } from "../utils";
import { Icon } from "./Icon";

export type TypographyVariant =
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "body"
  | "caption"
  | "overline"
  | "inline";
export type TypographyTone = "default" | "muted" | "primary" | "success" | "warning" | "danger";
export type ControlSize = "sm" | "md" | "lg";
export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";
export type Tone = "neutral" | "primary" | "success" | "warning" | "danger" | "info";

export const typographyVariants: Record<TypographyVariant, string> = {
  "heading-1": "text-4xl font-bold tracking-tight md:text-5xl",
  "heading-2": "text-3xl font-bold tracking-tight md:text-4xl",
  "heading-3": "text-2xl font-semibold tracking-tight md:text-3xl",
  body: "text-base leading-7",
  caption: "text-sm leading-6 text-base-content/70",
  overline: "text-overline uppercase text-base-content/70",
  inline: "inline text-base leading-6",
};

export const toneClasses: Record<TypographyTone, string> = {
  default: "text-base-content",
  muted: "text-base-content/70",
  primary: "text-primary",
  success: "text-success",
  warning: "text-warning",
  danger: "text-error",
};

export const buttonVariantClasses: Record<ButtonVariant, string> = {
  primary: "btn-primary",
  secondary: "btn-secondary",
  ghost: "btn-ghost",
  destructive: "btn-error text-error-content",
};

export function getBadgeClassName(tone: Tone): string {
  switch (tone) {
    case "primary":
      return "badge-primary";
    case "success":
      return "badge-success";
    case "warning":
      return "badge-warning";
    case "danger":
      return "badge-error";
    case "info":
      return "badge-info";
    default:
      return "badge-neutral";
  }
}

export function getAlertClassName(tone: Tone): string {
  switch (tone) {
    case "primary":
      return "alert-primary";
    case "success":
      return "alert-success";
    case "warning":
      return "alert-warning";
    case "danger":
      return "alert-error";
    case "info":
      return "alert-info";
    default:
      return "alert";
  }
}

export function useControllableState<T>(
  controlledValue: T | undefined,
  defaultValue: T,
  onChange?: (value: T) => void,
): [T, (nextValue: T) => void] {
  const [internalValue, setInternalValue] = React.useState(defaultValue);
  const value = controlledValue ?? internalValue;

  const setValue = React.useCallback(
    (nextValue: T) => {
      if (controlledValue === undefined) {
        setInternalValue(nextValue);
      }

      onChange?.(nextValue);
    },
    [controlledValue, onChange],
  );

  return [value, setValue];
}

export interface BaseFieldProps {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  description?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  controlSize?: ControlSize;
  leadingAdornment?: React.ReactNode;
  trailingAdornment?: React.ReactNode;
}

interface FieldChromeProps {
  className?: string;
  leadingAdornment?: React.ReactNode;
  trailingAdornment?: React.ReactNode;
  children: React.ReactNode;
}

export function FieldChrome({
  className,
  leadingAdornment,
  trailingAdornment,
  children,
}: FieldChromeProps) {
  return (
    <div className={cx("flex items-center gap-3 rounded-box border border-base-300 bg-base-100 px-3", className)}>
      {leadingAdornment ? <span className="text-base-content/60">{leadingAdornment}</span> : null}
      <div className="min-w-0 flex-1">{children}</div>
      {trailingAdornment ? <span className="text-base-content/60">{trailingAdornment}</span> : null}
    </div>
  );
}

export function DefaultArrowIcon() {
  return (
    <Icon size={18}>
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </Icon>
  );
}
