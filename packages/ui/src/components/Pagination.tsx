import * as React from "react";

import { cx } from "../utils";

export interface PaginationProps extends React.HTMLAttributes<HTMLDivElement> {
  page: number;
  totalPages: number;
  onPageChange?: (page: number) => void;
}

export function Pagination({ page, totalPages, onPageChange, className, ...props }: PaginationProps) {
  const pages = Array.from({ length: totalPages }, (_, index) => index + 1);

  return (
    <div className={cx("join", className)} {...props}>
      <button className="join-item btn" disabled={page <= 1} onClick={() => onPageChange?.(page - 1)} type="button">
        Previous
      </button>
      {pages.map((currentPage) => (
        <button
          className={cx("join-item btn", currentPage === page && "btn-primary")}
          key={currentPage}
          onClick={() => onPageChange?.(currentPage)}
          type="button"
        >
          {currentPage}
        </button>
      ))}
      <button className="join-item btn" disabled={page >= totalPages} onClick={() => onPageChange?.(page + 1)} type="button">
        Next
      </button>
    </div>
  );
}
