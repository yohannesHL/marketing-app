import * as React from "react";

import { cx } from "../utils";
import { useControllableState } from "./internal";
import { Surface } from "./Surface";

export interface TabItem {
  id: string;
  label: string;
  content: React.ReactNode;
  disabled?: boolean;
}

export interface TabsProps extends React.HTMLAttributes<HTMLDivElement> {
  items: TabItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
}

export function Tabs({ items, value, defaultValue, onValueChange, className, ...props }: TabsProps) {
  const [selectedValue, setSelectedValue] = useControllableState(
    value,
    defaultValue ?? items[0]?.id ?? "",
    onValueChange,
  );
  const activeItem = items.find((item) => item.id === selectedValue) ?? items[0];

  return (
    <div className={cx("grid gap-4", className)} {...props}>
      <div className="tabs tabs-boxed inline-flex w-fit gap-2 bg-base-200 p-1">
        {items.map((item) => (
          <button
            key={item.id}
            className={cx("tab no-underline", selectedValue === item.id && "tab-active")}
            disabled={item.disabled}
            onClick={() => setSelectedValue(item.id)}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>
      <Surface padding="md">{activeItem?.content}</Surface>
    </div>
  );
}
