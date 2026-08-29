import type { InputHTMLAttributes } from "react";

export function Slider({ className = "", ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return <input type="range" className={["ui-slider", className].filter(Boolean).join(" ")} {...rest} />;
}
