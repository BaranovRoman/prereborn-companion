import type { ButtonHTMLAttributes } from "react";

// Action hierarchy: primary = the one main action of a screen/section,
// default (secondary) = ordinary actions, ghost = low-weight helpers,
// danger = removing/disconnecting, link = inline text action.
type ButtonVariant = "default" | "secondary" | "primary" | "danger" | "ghost" | "link";
type ButtonSize = "default" | "small";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({ variant = "default", size = "default", className = "", ...rest }: ButtonProps) {
  const classes = ["ui-button"];
  if (variant !== "default" && variant !== "secondary") classes.push(`ui-button--${variant}`);
  if (size === "small") classes.push("ui-button--small");
  if (className) classes.push(className);
  return <button type="button" className={classes.join(" ")} {...rest} />;
}
