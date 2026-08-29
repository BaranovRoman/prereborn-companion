import type { ReactNode } from "react";

export interface SectionHeaderProps {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}

export function SectionHeader({ eyebrow, title, description, actions }: SectionHeaderProps) {
  return (
    <div className="ui-section-header">
      <div>
        {eyebrow && <span className="ui-section-header__eyebrow">{eyebrow}</span>}
        <h2 className="ui-section-header__title">{title}</h2>
        {description && <p className="ui-section-header__description">{description}</p>}
      </div>
      {actions && <div className="ui-section-header__actions">{actions}</div>}
    </div>
  );
}
