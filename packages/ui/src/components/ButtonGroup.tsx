import * as React from "react";

import { cx } from "../utils";

export interface ButtonGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export function ButtonGroup({ children, className, ...props }: ButtonGroupProps) {
  return (
    <div className={cx("join", className)} role="group" {...props}>
      {React.Children.map(children, (child) => {
        if (!React.isValidElement<{ className?: string }>(child)) {
          return child;
        }

        return React.cloneElement(child, {
          className: cx("join-item", child.props.className),
        });
      })}
    </div>
  );
}
