import type { ButtonHTMLAttributes } from "react";

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  size?: "default" | "small";
  "aria-label": string;
}

export function IconButton({ active, size = "default", className = "", title, ...rest }: IconButtonProps) {
  const classes = ["ui-icon-button"];
  if (active) classes.push("ui-icon-button--active");
  if (size === "small") classes.push("ui-icon-button--small");
  if (className) classes.push(className);
  return <button type="button" className={classes.join(" ")} title={title ?? rest["aria-label"]} {...rest} />;
}
