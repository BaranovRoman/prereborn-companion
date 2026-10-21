import type { ReactNode } from "react";

export interface PanelProps {
  title?: ReactNode;
  description?: ReactNode;
  /** Status/badges or actions shown at the right of the title. */
  aside?: ReactNode;
  className?: string;
  "aria-label"?: string;
  children?: ReactNode;
}

// One settings/content card: title + optional description, then content.
export function Panel({ title, description, aside, className = "", children, ...rest }: PanelProps) {
  return (
    <section className={["ui-panel", className].filter(Boolean).join(" ")} {...rest}>
      {(title || aside) && (
        <header className="ui-panel__header">
          <div>
            {title && <h2 className="ui-panel__title">{title}</h2>}
            {description && <p className="ui-panel__description">{description}</p>}
          </div>
          {aside && <div className="ui-panel__actions">{aside}</div>}
        </header>
      )}
      {children}
    </section>
  );
}
