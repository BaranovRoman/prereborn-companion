import type { SelectHTMLAttributes } from "react";

// `className` sizes the wrapper, so the chevron stays inside the field.
export function Select({ className = "", ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={["ui-select-wrap", className].filter(Boolean).join(" ")}>
      <select className="ui-select" {...rest} />
    </span>
  );
}
