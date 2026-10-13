import * as React from "react";

import { cx } from "../utils";

export interface CardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  title?: React.ReactNode;
  eyebrow?: React.ReactNode;
  footer?: React.ReactNode;
}

export function Card({ title, eyebrow, footer, className, children, ...props }: CardProps) {
  return (
    <div className={cx("card border border-base-300 bg-base-100 shadow-soft", className)} {...props}>
      <div className="card-body gap-5">
        {title || eyebrow ? (
          <div className="grid gap-2">
            {eyebrow ? <span className="text-overline uppercase text-primary">{eyebrow}</span> : null}
            {title ? <h3 className="card-title text-2xl">{title}</h3> : null}
          </div>
        ) : null}
        <div className="grid gap-4">{children}</div>
        {footer ? <div className="card-actions justify-between">{footer}</div> : null}
      </div>
    </div>
  );
}
