import type { InputHTMLAttributes, ReactNode } from "react";

export interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: ReactNode;
}

// WK-122 §5 - visually identical to Checkbox (same square, border,
// background, hover, focus, checked treatment - see ui.css's shared
// `.ui-checkbox__box, .ui-radio__box` rule block), semantically a real
// `type="radio"` input so name-grouping/keyboard arrow-key navigation and
// screen-reader behavior stay exactly what a native radio group provides.
// Behavior differs from Checkbox (mutually exclusive via a shared `name`,
// not independent); the look does not.
export function Radio({ label, className = "", disabled, id, ...rest }: RadioProps) {
  const classes = ["ui-radio"];
  if (disabled) classes.push("is-disabled");
  if (className) classes.push(className);
  return (
    <label className={classes.join(" ")} htmlFor={id}>
      <input type="radio" id={id} className="ui-radio__box" disabled={disabled} {...rest} />
      {label}
    </label>
  );
}
