import * as React from "react";

import { cx } from "../utils";
import { FieldGroup } from "./FieldGroup";
import { useControllableState } from "./internal";

export interface RadioItem {
  label: string;
  value: string;
  description?: string;
  disabled?: boolean;
}

export interface RadioGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  name: string;
  items: RadioItem[];
  label?: React.ReactNode;
  description?: React.ReactNode;
  error?: React.ReactNode;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
}

export function RadioGroup({
  name,
  items,
  label,
  description,
  error,
  value,
  defaultValue,
  onValueChange,
  className,
  ...props
}: RadioGroupProps) {
  const [selectedValue, setSelectedValue] = useControllableState(
    value,
    defaultValue ?? items[0]?.value ?? "",
    onValueChange,
  );

  return (
    <FieldGroup description={description} error={error} label={label}>
      <div className={cx("grid gap-3", className)} role="radiogroup" {...props}>
        {items.map((item) => (
          <label className="label cursor-pointer justify-start gap-3 rounded-box border border-base-300 bg-base-100 px-4 py-3" key={item.value}>
            <input
              checked={selectedValue === item.value}
              className="radio radio-primary"
              disabled={item.disabled}
              name={name}
              onChange={() => setSelectedValue(item.value)}
              type="radio"
              value={item.value}
            />
            <span className="grid gap-1">
              <span className="label-text text-base font-medium text-base-content">{item.label}</span>
              {item.description ? <span className="text-sm text-base-content/70">{item.description}</span> : null}
            </span>
          </label>
        ))}
      </div>
    </FieldGroup>
  );
}
