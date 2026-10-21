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
  /** Live state of this setting (e.g. "Не удалось зарегистрировать"). */
  status?: ReactNode;
  /** Control under the text instead of at the right (wide controls). */
  stacked?: boolean;
  children: ReactNode;
}

// One setting: name, explanation, status on the left; its control on the right.
export function SettingsRow({ label, description, status, stacked, children }: SettingsRowProps) {
  return (
    <div className={`ui-settings-row${stacked ? " ui-settings-row--stacked" : ""}`}>
      <div className="ui-settings-row__label">
        <span className="ui-settings-row__title">{label}</span>
        {description && <span className="ui-settings-row__description">{description}</span>}
        {status && <span className="ui-settings-row__status">{status}</span>}
      </div>
      <div className="ui-settings-row__control">{children}</div>
    </div>
  );
}
