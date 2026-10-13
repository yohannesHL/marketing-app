import * as React from "react";

import { cx } from "../utils";

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

export interface BreadcrumbsProps extends React.HTMLAttributes<HTMLDivElement> {
  items: BreadcrumbItem[];
}

export function Breadcrumbs({ items, className, ...props }: BreadcrumbsProps) {
  return (
    <div className={cx("breadcrumbs text-sm", className)} {...props}>
      <ul>
        {items.map((item, index) => (
          <li key={`${item.label}-${index}`}>{item.href ? <a href={item.href}>{item.label}</a> : <span>{item.label}</span>}</li>
        ))}
      </ul>
    </div>
  );
}
