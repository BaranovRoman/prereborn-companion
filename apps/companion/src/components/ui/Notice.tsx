import type { ReactNode } from "react";

type Tone = "info" | "success" | "warning" | "danger";

// Inline status message. danger -> role="alert", others -> role="status".
export function Notice({ tone = "info", action, children }: { tone?: Tone; action?: ReactNode; children: ReactNode }) {
  return (
    <div className={`ui-notice ui-notice--${tone}`} role={tone === "danger" ? "alert" : "status"}>
      <div className="ui-notice__body">{children}</div>
      {action}
    </div>
  );
}
