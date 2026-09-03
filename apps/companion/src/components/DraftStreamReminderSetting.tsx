import { Checkbox } from "./ui";

interface Props {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}

// WK-136 - "Стрим не запущен" reminder toggle. Mirrors AutostartSetting.tsx's
// shape (a single self-contained checkbox setting, no async/loading state
// since this is purely local, no Rust round-trip needed to read/change it).
export function DraftStreamReminderSetting({ enabled, onChange }: Props) {
  return (
    <section className="autostart-setting">
      <h2>Напоминание «Стрим не запущен»</h2>
      <Checkbox
        checked={enabled}
        onChange={(event) => onChange(event.target.checked)}
        label="Голосовое напоминание, если стрим не запущен во время пика"
      />
      <p className="autostart-setting__hint">
        Срабатывает один раз при входе в Драфт, если OBS подключён, но подтверждённо не стримит. Не зависит от
        того, включён ли TTS в чате Twitch.
      </p>
    </section>
  );
}
