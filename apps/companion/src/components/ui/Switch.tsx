import type { InputHTMLAttributes, ReactNode } from "react";

export interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "role"> {
  label?: ReactNode;
  hint?: ReactNode;
}

// Immediate on/off settings (applied as soon as they change). Semantically a
// checkbox with role="switch", so forms, change events and keyboard (Space)
// behave exactly like the checkbox it replaces.
export function Switch({ label, hint, className = "", disabled, id, ...rest }: SwitchProps) {
  const classes = ["ui-switch"];
  if (disabled) classes.push("is-disabled");
  if (className) classes.push(className);
  return (
    <label className={classes.join(" ")} htmlFor={id}>
      <input type="checkbox" role="switch" id={id} className="ui-switch__input" disabled={disabled} {...rest} />
      <span className="ui-switch__track" aria-hidden="true" />
      {(label || hint) && <span className="ui-check__text">{label}{hint && <span className="ui-check__hint" aria-hidden="true">{hint}</span>}</span>}
    </label>
  );
}
