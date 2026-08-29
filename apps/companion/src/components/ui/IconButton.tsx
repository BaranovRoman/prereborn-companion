import type { ButtonHTMLAttributes } from "react";

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  "aria-label": string;
}

export function IconButton({ active, className = "", ...rest }: IconButtonProps) {
  const classes = ["ui-icon-button"];
  if (active) classes.push("ui-icon-button--active");
  if (className) classes.push(className);
  return <button type="button" className={classes.join(" ")} {...rest} />;
}
