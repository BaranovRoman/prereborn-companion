import type { AutostartState } from "../hooks/useAutostart";

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
    <section className="autostart-setting">
      <h2>Автозапуск с Windows</h2>
      <label className="autostart-setting__toggle">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        Запускать Companion вместе с Windows
      </label>
      <p className="autostart-setting__hint">
        Companion откроется свёрнутым в трей при следующем входе в Windows.
      </p>
      {state.phase === "error" && (
        <p className="app__error">Не удалось изменить автозапуск: {state.message}</p>
      )}
    </section>
  );
}
