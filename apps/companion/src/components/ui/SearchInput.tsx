import type { InputHTMLAttributes } from "react";

export interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  onClear?: () => void;
}

export function SearchInput({ value, onClear, className = "", ...rest }: SearchInputProps) {
  return (
    <span className={["ui-search", className].filter(Boolean).join(" ")}>
      <svg className="ui-search__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
        <path d="M11 11L14.5 14.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <input type="search" className="ui-input" value={value} {...rest} />
      {onClear && typeof value === "string" && value.length > 0 && (
        <button type="button" className="ui-search__clear" onClick={onClear} aria-label="Очистить поиск">✕</button>
      )}
    </span>
  );
}
