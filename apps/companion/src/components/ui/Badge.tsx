import type { ReactNode } from "react";

type BadgeTone = "default" | "success" | "danger" | "warning" | "gold";

export interface BadgeProps {
  tone?: BadgeTone;
  dot?: boolean;
  children: ReactNode;
}

export function Badge({ tone = "default", dot, children }: BadgeProps) {
  const classes = ["ui-badge"];
  if (tone !== "default") classes.push(`ui-badge--${tone}`);
  return (
    <span className={classes.join(" ")}>
      {dot && <span className="ui-badge__dot" />}
      {children}
    </span>
  );
}
