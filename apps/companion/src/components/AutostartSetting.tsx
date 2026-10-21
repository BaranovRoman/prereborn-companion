import type { AutostartState } from "../hooks/useAutostart";
import { SettingsRow, Switch } from "./ui";

interface Props {
  state: AutostartState;
  busy: boolean;
  onChange: (enabled: boolean) => void;
}

// Companion UI 2.0 - "Запускать вместе с Windows" (Settings). Reflects the
// real OS state from useAutostart - "loading" shows the checkbox disabled
// rather than defaulting to checked/unchecked and guessing.
export function AutostartSetting({ state, busy, onChange }: Props) {
  const checked = state.phase !== "loading" && state.enabled;
  const disabled = busy || state.phase === "loading";

  return (
    <SettingsRow
      label="Запускать вместе с Windows"
      description="Companion откроется свёрнутым в трей при следующем входе в Windows."
      status={state.phase === "error" ? <span className="ui-text-danger" role="alert">Не удалось изменить автозапуск: {state.message}</span> : undefined}
    >
      <Switch
        aria-label="Запускать Companion вместе с Windows"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </SettingsRow>
  );
}
