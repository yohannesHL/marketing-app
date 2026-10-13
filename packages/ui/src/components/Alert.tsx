import * as React from "react";

import { cx } from "../utils";
import { DefaultArrowIcon, getAlertClassName, type Tone } from "./internal";

export interface AlertProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  tone?: Tone;
  title?: React.ReactNode;
  icon?: React.ReactNode;
  action?: React.ReactNode;
}

export function Alert({ tone = "info", title, icon, action, className, children, ...props }: AlertProps) {
  return (
    <div className={cx("alert items-start shadow-soft", getAlertClassName(tone), className)} role="alert" {...props}>
      {icon ?? <DefaultArrowIcon />}
      <div>
        {title ? <h4 className="font-semibold">{title}</h4> : null}
        <div className="text-sm leading-6">{children}</div>
      </div>
      {action ? <div>{action}</div> : null}
    </div>
  );
}
