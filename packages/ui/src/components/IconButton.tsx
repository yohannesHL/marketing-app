import * as React from "react";

import { cx } from "../utils";
import { Button, type ButtonProps } from "./Button";
import { type ControlSize } from "./internal";

export interface IconButtonProps extends Omit<ButtonProps, "children"> {
  "aria-label": string;
  icon: React.ReactNode;
  size?: ControlSize;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, className, size = "md", ...props },
  ref,
) {
  return (
    <Button ref={ref} className={cx("btn-square", className)} size={size} {...props}>
      {icon}
    </Button>
  );
});
