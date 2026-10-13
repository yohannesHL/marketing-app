import * as React from "react";

import { cx } from "../utils";

export interface AdPreviewProps extends React.HTMLAttributes<HTMLDivElement> {
  headline: string;
  description: string;
  imageUrl?: string;
}

export function AdPreview({
  headline,
  description,
  imageUrl,
  className,
  ...props
}: AdPreviewProps) {
  return (
    <div
      className={cx(
        "rounded-xl border border-base-300 bg-base-200/50 p-4",
        className,
      )}
      {...props}
    >
      <div className="mb-3 text-xs font-medium uppercase tracking-wider text-base-content/50">
        AD PREVIEW
      </div>
      <div className="rounded-lg border border-base-300 bg-base-100 p-4">
        <div className="mb-1 text-xs text-base-content/50">Sponsored</div>
        <h4 className="mb-1 font-semibold text-base-content">
          {headline || "Headline"}
        </h4>
        <p className="mb-3 text-sm text-base-content/70">
          {description || "Description"}
        </p>
        <div className="flex aspect-video items-center justify-center rounded-lg bg-base-200 text-base-content/40">
          {imageUrl ? (
            <img
              src={imageUrl}
              alt="Ad preview"
              className="h-full w-full rounded-lg object-cover"
            />
          ) : (
            <span className="text-sm">Ad Image</span>
          )}
        </div>
      </div>
    </div>
  );
}
