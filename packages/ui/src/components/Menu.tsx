import * as React from "react";

import { cx } from "../utils";

export interface MenuItem {
  label: string;
  onSelect?: () => void;
  href?: string;
  disabled?: boolean;
}

export interface MenuProps extends React.HTMLAttributes<HTMLDetailsElement> {
  label: React.ReactNode;
  items: MenuItem[];
}

export function Menu({ label, items, className, ...props }: MenuProps) {
  return (
    <details className={cx("dropdown", className)} {...props}>
      <summary className="btn m-0 list-none normal-case">{label}</summary>
      <ul className="menu dropdown-content z-[1] mt-2 w-56 rounded-box border border-base-300 bg-base-100 p-2 shadow-soft">
        {items.map((item) => (
          <li key={item.label}>
            {item.href ? (
              <a aria-disabled={item.disabled} className={item.disabled ? "pointer-events-none opacity-50" : undefined} href={item.href}>
                {item.label}
              </a>
            ) : (
              <button disabled={item.disabled} onClick={item.onSelect} type="button">
                {item.label}
              </button>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
