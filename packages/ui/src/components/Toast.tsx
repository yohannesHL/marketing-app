import * as React from "react";

import { cx } from "../utils";
import { Alert, type AlertProps } from "./Alert";

export interface ToastProps extends AlertProps {
  position?: "top-end" | "top-center" | "bottom-end" | "bottom-center";
  floating?: boolean;
}

export function Toast({ position = "top-end", floating = false, className, ...props }: ToastProps) {
  const floatingClasses = {
    "top-end": "toast toast-top toast-end",
    "top-center": "toast toast-top toast-center",
    "bottom-end": "toast toast-bottom toast-end",
    "bottom-center": "toast toast-bottom toast-center",
  } as const;

  const content = <Alert className={cx("w-full max-w-md", className)} {...props} />;

  if (!floating) {
    return content;
  }

  return <div className={floatingClasses[position]}>{content}</div>;
}
