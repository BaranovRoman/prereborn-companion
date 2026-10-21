import type { ReactNode } from "react";

// Heading of one plugin tab: title, one-line purpose, optional actions.
export function View({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="dota-view__header">
      <div><h2>{title}</h2>{description && <p>{description}</p>}</div>
      {actions && <div className="ui-button-row">{actions}</div>}
    </div>
  );
}
