import { useEffect, useState } from "react";
import { HotkeyBindRow } from "../../../../../apps/companion/src/components/HotkeySettings";
import { invoke } from "../api";
import { DesignPage } from "./DesignPage";

interface Hotkey { enabled:boolean; shortcut:string; registered:boolean; lastError:string|null }
export function OverlayPanel({active,visible,reload}:{active:boolean;visible:boolean;reload:()=>Promise<void>}) {
  const [hotkey,setHotkey]=useState<Hotkey|null>(null);const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);const [result,setResult]=useState<string|null>(null);
  useEffect(()=>{let disposed=false;void invoke<Hotkey>("overlay.hotkey").then(value=>{if(!disposed)setHotkey(value);}).catch(e=>{if(!disposed)setError(String(e));});return()=>{disposed=true;};},[active]);
  const run=async(action:()=>Promise<void>)=>{setBusy(true);setError(null);setResult(null);try{await action();await reload();}catch(e){setError(String(e));}finally{setBusy(false);}};
  return <section className="overlay-panel">
    <div className="overlay-panel__top">
      <div className="overlay-panel__source">
        <label>OBS Browser Source <input aria-label="Адрес overlay" readOnly value="http://127.0.0.1:3666/overlay" onFocus={e=>e.currentTarget.select()}/></label>
        <small>1920 × 1080, прозрачный фон. Работает, пока плагин включён.</small>
        <div className="sound-binding-row__actions">
      <button disabled={!active||busy} onClick={()=>void run(async()=>{const response=await invoke<{visible:boolean}>("overlay.visibility",{visible:!visible});if(response.visible!==!visible)throw Error("overlay_visibility_unconfirmed");setResult(response.visible?"Overlay показан.":"Overlay скрыт.");})}>{visible?"Скрыть overlay":"Показать overlay"}</button>
        </div>
      </div>
      <div className="overlay-panel__hotkey">
    <HotkeyBindRow enableDescription="Показать или скрыть только Dota overlay. Работает при включённом плагине." bindLabel="Видимость overlay" status={hotkey} busy={busy} defaultShortcut="CommandOrControl+Alt+F11" onUpdate={async(enabled,shortcut)=>{await run(async()=>{setHotkey(await invoke<Hotkey>("overlay.hotkey.save",{enabled,shortcut}));setResult("Горячая клавиша сохранена.");});}}/>
      </div>
    </div>
    {error&&<p role="alert">{error}</p>}{result&&<p role="status">{result}</p>}
    <DesignPage/>
  </section>;
}
