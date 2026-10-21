import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
  /** One control (Input, Select, Textarea, ...) that accepts `id`. */
  children: ReactNode;
}

// Label above its control, optional hint below. The label names the control
// and the hint describes it (aria-describedby), so neither leaks into the other.
export function Field({ label, hint, disabled, className = "", children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<{ id?: string; "aria-describedby"?: string }>, { id, "aria-describedby": hint ? hintId : undefined })
    : children;
  return (
    <div className={["ui-field", disabled ? "is-disabled" : "", className].filter(Boolean).join(" ")}>
      <label className="ui-field__label" htmlFor={id}>{label}</label>
      {control}
      {hint && <span className="ui-field__hint" id={hintId}>{hint}</span>}
    </div>
  );
}
