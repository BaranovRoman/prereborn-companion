import type { InputHTMLAttributes, ReactNode } from "react";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: ReactNode;
  /** Secondary explanation under the label, kept out of the accessible name. */
  hint?: ReactNode;
}

export function Checkbox({ label, hint, className = "", disabled, id, ...rest }: CheckboxProps) {
  const classes = ["ui-checkbox"];
  if (disabled) classes.push("is-disabled");
  if (className) classes.push(className);
  return (
    <label className={classes.join(" ")} htmlFor={id}>
      <input type="checkbox" id={id} className="ui-checkbox__box" disabled={disabled} {...rest} />
      {(label || hint) && <span className="ui-check__text">{label}{hint && <span className="ui-check__hint" aria-hidden="true">{hint}</span>}</span>}
    </label>
  );
}
