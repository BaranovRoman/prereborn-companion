import type { CSSProperties, InputHTMLAttributes } from "react";

export function Slider({
  className = "",
  style,
  min = 0,
  max = 100,
  value,
  defaultValue,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const lo = Number(min);
  const hi = Number(max);
  const current = Number(value ?? defaultValue ?? lo);
  const fill = hi > lo ? ((current - lo) / (hi - lo)) * 100 : 0;
  const fillStyle = { "--ui-slider-fill": `${Math.min(100, Math.max(0, fill))}%` } as CSSProperties;

  return (
    <input
      type="range"
      className={["ui-slider", className].filter(Boolean).join(" ")}
      min={min}
      max={max}
      value={value}
      defaultValue={defaultValue}
      style={{ ...fillStyle, ...style }}
      {...rest}
    />
  );
}
