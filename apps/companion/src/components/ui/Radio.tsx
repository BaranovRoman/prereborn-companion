import type { InputHTMLAttributes, ReactNode } from "react";

export interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: ReactNode;
  hint?: ReactNode;
  /** Render as a selectable option card (for a ChoiceGroup). */
  card?: boolean;
}

// A real `type="radio"`: name-grouping, arrow-key navigation and screen
// readers behave as a native radio group.
export function Radio({ label, hint, card, className = "", disabled, checked, id, ...rest }: RadioProps) {
  const classes = ["ui-radio"];
  if (card) classes.push("ui-choice");
  if (card && checked) classes.push("is-checked");
  if (disabled) classes.push("is-disabled");
  if (className) classes.push(className);
  return (
    <label className={classes.join(" ")} htmlFor={id}>
      <input type="radio" id={id} className="ui-radio__box" disabled={disabled} checked={checked} {...rest} />
      {(label || hint) && <span className="ui-check__text">{label}{hint && <span className="ui-check__hint" aria-hidden="true">{hint}</span>}</span>}
    </label>
  );
}

export function ChoiceGroup({ legend, row, children }: { legend: string; row?: boolean; children: ReactNode }) {
  return (
    <fieldset className={`ui-choice-group${row ? " ui-choice-group--row" : ""}`} aria-label={legend}>
      {children}
    </fieldset>
  );
}
