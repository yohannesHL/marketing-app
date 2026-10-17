import { Badge, type BadgeProps } from "@launchpad/ui";

export function TrackingBadge({ tone = "neutral", className = "", ...props }: BadgeProps) {
  return <Badge tone={tone} className={`${tone === "neutral" ? "!bg-base-200 !text-base-content" : ""} ${className}`} {...props} />;
}
