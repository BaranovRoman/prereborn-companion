import { useEffect, useRef, useState } from "react";
import * as api from "../api";

interface TracePage { recording: boolean; total: number; dropped: number; events: unknown[] }

// Opt-in item diagnostic: what the plugin actually sees in GSI item slots
// (appear / cooldown start / charges / removed), to classify items by real
// signals instead of metadata. Nothing leaves the app unless copied.
export function ItemTracePanel() {
  const [state, setState] = useState<{ recording: boolean; total: number; dropped: number }>({ recording: false, total: 0, dropped: 0 });
  const [log, setLog] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const refresh = async () => { const page = await api.invoke<TracePage>("items.trace", { offset: 0 }); setState(page); };
  useEffect(() => {
    void refresh().catch(() => undefined);
    if (!state.recording) return;
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 2000);
    return () => window.clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.recording]);
  const run = async (task: () => Promise<void>) => { setError(null); try { await task(); } catch (e) { setError(String(e)); } };
  const load = async () => {
    const events: unknown[] = []; let total = 1;
    while (events.length < total) { const page = await api.invoke<TracePage>("items.trace", { offset: events.length }); total = page.total; if (!page.events.length) break; events.push(...page.events); }
    setLog(events.map((event) => JSON.stringify(event)).join("\n"));
  };
  return <details className="item-trace">
    <summary>Диагностика предметов {state.recording ? `· идёт запись (${state.total})` : state.total ? `· записано ${state.total}` : ""}</summary>
    <p>Записывает только изменения в слотах предметов: появился, начался кулдаун, изменились заряды, исчез. Работает, пока плагин включён и Dota отправляет GSI.</p>
    <div className="sound-binding-row__actions">
      {!state.recording
        ? <button onClick={() => void run(async () => { await api.invoke("items.trace.start", {}); setLog(""); await refresh(); })}>Начать запись</button>
        : <button onClick={() => void run(async () => { await api.invoke("items.trace.stop", {}); await refresh(); await load(); })}>Остановить</button>}
      <button disabled={!state.total} onClick={() => void run(load)}>Показать журнал</button>
      <button disabled={!log} onClick={() => { area.current?.focus(); area.current?.select(); void navigator.clipboard?.writeText(log).catch(() => undefined); }}>Выделить и скопировать</button>
    </div>
    {state.dropped > 0 && <p>Журнал заполнен, пропущено событий: {state.dropped}. Остановите и начните заново.</p>}
    {error && <p role="alert">{error}</p>}
    {log && <textarea ref={area} readOnly value={log} rows={10} aria-label="Журнал предметов" />}
  </details>;
}
