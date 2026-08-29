import type { ButtonHTMLAttributes } from "react";

type ButtonVariant = "default" | "primary" | "danger" | "ghost";
type ButtonSize = "default" | "small";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({ variant = "default", size = "default", className = "", ...rest }: ButtonProps) {
  const classes = ["ui-button"];
  if (variant !== "default") classes.push(`ui-button--${variant}`);
  if (size === "small") classes.push("ui-button--small");
  if (className) classes.push(className);
  return <button type="button" className={classes.join(" ")} {...rest} />;
}
