import type { SelectHTMLAttributes } from "react";

export function Select({ className = "", ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="ui-select-wrap">
      <select className={["ui-select", className].filter(Boolean).join(" ")} {...rest} />
    </span>
  );
}
