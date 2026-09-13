interface Props {
  toLabel: string | null;
  onSwitch: () => void;
  onKeep: () => void;
}

// Reliability follow-up - explicit-device mode only: Windows default output
// changed while the user has an explicit device pinned. Deliberately never
// auto-switches (see задача's "не переключать TTS/алерты автоматически") -
// this is the "Switch/Keep" prompt, offered once per distinct transition
// (dedup lives in useAudioOutputDevice.ts). Reuses UpdateBanner.tsx's exact
// banner-with-actions shape/CSS classes rather than adding a second banner
// idiom or forcing this two-choice prompt into ProblemBar's plain
// label+detail(+single dismiss) item shape.
export function AudioDeviceChangeBanner({ toLabel, onSwitch, onKeep }: Props) {
  if (!toLabel) return null;

  return (
    <section className="update-banner update-banner--available">
      <div>
        <strong>Системный вывод сменился на «{toLabel}»</strong>
        <p className="update-banner__notes">Переключить TTS/алерты Companion на это устройство?</p>
      </div>
      <div className="update-banner__actions">
        <button className="button button--primary" onClick={onSwitch}>Переключить</button>
        <button className="button" onClick={onKeep}>Оставить текущее</button>
      </div>
    </section>
  );
}
