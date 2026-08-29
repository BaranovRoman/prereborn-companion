import type { ReactNode } from "react";

export interface SettingsGroupProps {
  title?: string;
  children: ReactNode;
}

export function SettingsGroup({ title, children }: SettingsGroupProps) {
  return (
    <div className="ui-settings-group">
      {title && <h3 className="ui-settings-group__title">{title}</h3>}
      {children}
    </div>
  );
}

export interface SettingsRowProps {
  label: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}

export function SettingsRow({ label, description, children }: SettingsRowProps) {
  return (
    <div className="ui-settings-row">
      <div className="ui-settings-row__label">
        <strong>{label}</strong>
        {description && <span>{description}</span>}
      </div>
      <div className="ui-settings-row__control">{children}</div>
    </div>
  );
}
