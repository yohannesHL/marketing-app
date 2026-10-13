import * as React from "react";

import { cx } from "../utils";

export interface AccordionItem {
  id: string;
  title: string;
  content: React.ReactNode;
}

export interface AccordionProps extends React.HTMLAttributes<HTMLDivElement> {
  items: AccordionItem[];
  allowMultiple?: boolean;
  defaultOpenIds?: string[];
}

export function Accordion({ items, allowMultiple = false, defaultOpenIds = [], className, ...props }: AccordionProps) {
  const [openIds, setOpenIds] = React.useState<string[]>(defaultOpenIds);

  function toggleItem(id: string) {
    setOpenIds((currentIds) => {
      if (currentIds.includes(id)) {
        return currentIds.filter((currentId) => currentId !== id);
      }

      return allowMultiple ? [...currentIds, id] : [id];
    });
  }

  return (
    <div className={cx("grid gap-3", className)} {...props}>
      {items.map((item) => {
        const isOpen = openIds.includes(item.id);
        return (
          <div className={cx("collapse collapse-arrow border border-base-300 bg-base-100", isOpen && "collapse-open")} key={item.id}>
            <button className="collapse-title text-left text-lg font-semibold" onClick={() => toggleItem(item.id)} type="button">
              {item.title}
            </button>
            <div className="collapse-content text-base-content/70">{item.content}</div>
          </div>
        );
      })}
    </div>
  );
}
