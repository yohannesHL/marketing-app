"use client";
import { Typography } from "@launchpad/ui";
import Image from "next/image";
import { mediaPath, type SocialMedia } from "./socialUi";
export function MediaPreview({ media }: { media: SocialMedia[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {media.map((item) => (
        <figure
          key={item.id}
          className="!block min-w-0 rounded-box border border-base-300 p-3"
        >
          {item.type === "VIDEO" ? (
            <video
              className="max-h-80 w-full rounded-lg bg-base-200"
              src={mediaPath(item.id)}
              controls
              preload="metadata"
              aria-label={item.filename ?? "Uploaded video preview"}
            />
          ) : (
            <Image
              unoptimized
              width={item.width}
              height={item.height}
              className="h-auto max-h-80 w-full rounded-lg object-contain"
              src={mediaPath(item.id)}
              alt={item.filename ?? "Uploaded image preview"}
            />
          )}
          <figcaption className="mt-3 break-words [overflow-wrap:anywhere]">
            <Typography variant="caption">
              {item.filename ?? `${item.type.toLowerCase()} attachment`} ·{" "}
              {item.width} × {item.height}
              {item.durationMs
                ? ` · ${(item.durationMs / 1000).toFixed(1)} seconds`
                : ""}{" "}
              · {(item.bytes / 1048576).toFixed(1)} MB
            </Typography>
            {item.expiresAt ? (
              <Typography variant="caption" tone="muted">
                Available until {new Date(item.expiresAt).toLocaleString()}
              </Typography>
            ) : null}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}
