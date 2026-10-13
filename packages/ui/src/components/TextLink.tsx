import * as React from "react";

import { cx } from "../utils";

export interface TextLinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  standalone?: boolean;
}

export function TextLink({ standalone = false, className, ...props }: TextLinkProps) {
  return (
    <a
      className={cx(
        "font-semibold text-primary transition hover:text-primary-focus hover:underline",
        standalone && "inline-flex items-center gap-2",
        className,
      )}
      {...props}
    />
  );
}
