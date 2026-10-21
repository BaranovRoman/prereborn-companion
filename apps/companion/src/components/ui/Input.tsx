import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";

export function Input({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={["ui-input", className].filter(Boolean).join(" ")} {...rest} />;
}

export function Textarea({ className = "", ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={["ui-textarea", className].filter(Boolean).join(" ")} {...rest} />;
}
