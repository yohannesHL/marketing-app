import * as React from "react";

import { cx } from "../utils";
import { DefaultArrowIcon } from "./internal";
import { Surface } from "./Surface";

export interface EmptyStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  title: React.ReactNode;
  description: React.ReactNode;
  action?: React.ReactNode;
  illustration?: React.ReactNode;
}

export function EmptyState({ title, description, action, illustration, className, ...props }: EmptyStateProps) {
  return (
    <Surface className={cx("grid justify-items-center gap-4 text-center", className)} padding="lg" {...props}>
      {illustration ? (
        <div>{illustration}</div>
      ) : (
        <div className="rounded-full bg-primary/10 p-4 text-primary">
          <DefaultArrowIcon />
        </div>
      )}
      <div className="grid gap-2">
        <h3 className="text-2xl font-semibold">{title}</h3>
        <p className="max-w-md text-base-content/70">{description}</p>
      </div>
      {action ? <div>{action}</div> : null}
    </Surface>
  );
}
