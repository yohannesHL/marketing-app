import * as React from "react";

import { cx } from "../utils";

export interface AvatarProps extends React.HTMLAttributes<HTMLDivElement> {
  src?: string;
  alt?: string;
  name?: string;
  size?: "sm" | "md" | "lg";
}

export function Avatar({ src, alt, name = "LP", size = "md", className, ...props }: AvatarProps) {
  const fallback = name
    .split(" ")
    .map((part) => part.charAt(0).toUpperCase())
    .join("")
    .slice(0, 2);

  return (
    <div className={cx("avatar placeholder", className)} {...props}>
      <div className={cx("rounded-full bg-primary text-primary-content", size === "sm" && "w-10", size === "md" && "w-12", size === "lg" && "w-16")}>
        {src ? <img alt={alt ?? name} src={src} /> : <span className="font-semibold">{fallback}</span>}
      </div>
    </div>
  );
}
