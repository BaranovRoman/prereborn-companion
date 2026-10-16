import { useEffect, useState } from "react";
import { HotkeyBindRow } from "../../../../../apps/companion/src/components/HotkeySettings";
import { invoke } from "../api";

interface Hotkey { enabled:boolean; shortcut:string; registered:boolean; lastError:string|null }
export function OverlayPanel({active,visible,showSummary,reload}:{active:boolean;visible:boolean;showSummary:boolean;reload:()=>Promise<void>}) {
  const [hotkey,setHotkey]=useState<Hotkey|null>(null);const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);const [result,setResult]=useState<string|null>(null);
  const [scene,setScene]=useState("betweenMatches");
  useEffect(()=>{let disposed=false;void invoke<Hotkey>("overlay.hotkey").then(value=>{if(!disposed)setHotkey(value);}).catch(e=>{if(!disposed)setError(String(e));});return()=>{disposed=true;};},[active]);
  const run=async(action:()=>Promise<void>)=>{setBusy(true);setError(null);setResult(null);try{await action();await reload();}catch(e){setError(String(e));}finally{setBusy(false);}};
  return <section><h2>Игровой overlay</h2>
    <p>Источник браузера OBS: <input aria-label="Адрес overlay" readOnly value="http://127.0.0.1:3666/overlay"/></p>
    <p>1920 × 1080, прозрачный фон. Локальный renderer работает только при включённом плагине.</p>
    <div className="sound-binding-row__actions">
      <button disabled={!active||busy} onClick={()=>void run(async()=>{const response=await invoke<{visible:boolean}>("overlay.visibility",{visible:!visible});if(response.visible!==!visible)throw Error("overlay_visibility_unconfirmed");setResult(response.visible?"Overlay показан.":"Overlay скрыт.");})}>{visible?"Скрыть overlay":"Показать overlay"}</button>
      <button disabled={!active||busy} onClick={()=>void run(async()=>{const response=await invoke<{show:boolean}>("overlay.summary",{show:!showSummary});if(response.show!==!showSummary)throw Error("overlay_summary_unconfirmed");setResult(response.show?"Показаны итоги сессии.":"Возобновлена автоматическая сцена.");})}>{showSummary?"Автоматическая сцена":"Показать итоги"}</button>
    </div>
    <HotkeyBindRow enableDescription="Показать или скрыть только Dota overlay. Работает при включённом плагине." bindLabel="Видимость overlay" status={hotkey} busy={busy} defaultShortcut="CommandOrControl+Alt+F11" onUpdate={async(enabled,shortcut)=>{await run(async()=>{setHotkey(await invoke<Hotkey>("overlay.hotkey.save",{enabled,shortcut}));setResult("Горячая клавиша сохранена.");});}}/>
    {error&&<p role="alert">{error}</p>}{result&&<p role="status">{result}</p>}
    <label>Предпросмотр сцены <select value={scene} onChange={e=>setScene(e.target.value)}>{[["betweenMatches","Между матчами"],["draft","Драфт"],["gameplay","Игра"],["postStream","Итоги"]].map(([key,label])=><option value={key} key={key}>{label}</option>)}</select></label>
    {active?<iframe title="Локальный Dota overlay" sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" src={`http://127.0.0.1:3666/overlay?previewScene=${scene}&editor=1`} style={{width:"100%",aspectRatio:"16 / 9",border:0}}/>:<p>Включите плагин для предпросмотра overlay.</p>}
  </section>;
}
