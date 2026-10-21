import { useEffect, useState } from "react";
import { HotkeyBindRow } from "../../../../../apps/companion/src/components/HotkeySettings";
import { invoke } from "../api";
import { DesignPage } from "./DesignPage";
import { Badge, Button, Input, Panel } from "./ui";
import { View } from "./View";

interface Hotkey { enabled:boolean; shortcut:string; registered:boolean; lastError:string|null }
export function OverlayPanel({active,visible,reload}:{active:boolean;visible:boolean;reload:()=>Promise<void>}) {
  const [hotkey,setHotkey]=useState<Hotkey|null>(null);const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);const [result,setResult]=useState<string|null>(null);
  useEffect(()=>{let disposed=false;void invoke<Hotkey>("overlay.hotkey").then(value=>{if(!disposed)setHotkey(value);}).catch(e=>{if(!disposed)setError(String(e));});return()=>{disposed=true;};},[active]);
  const run=async(action:()=>Promise<void>)=>{setBusy(true);setError(null);setResult(null);try{await action();await reload();}catch(e){setError(String(e));}finally{setBusy(false);}};
  return <section className="dota-view overlay-panel">
    <View title="Overlay" description="Оверлей для OBS Browser Source и редактор его оформления."/>
    <div className="overlay-panel__top">
      <Panel title="Источник для OBS" aside={<Badge tone={!active?"default":visible?"success":"warning"} dot={active}>{!active?"Плагин выключен":visible?"Показан":"Скрыт"}</Badge>}>
        <div className="overlay-panel__source">
          <Input aria-label="Адрес overlay" readOnly value="http://127.0.0.1:3666/overlay" onFocus={e=>e.currentTarget.select()}/>
          <Button disabled={!active||busy} onClick={()=>void run(async()=>{const response=await invoke<{visible:boolean}>("overlay.visibility",{visible:!visible});if(response.visible!==!visible)throw Error("overlay_visibility_unconfirmed");setResult(response.visible?"Overlay показан.":"Overlay скрыт.");})}>{visible?"Скрыть overlay":"Показать overlay"}</Button>
        </div>
        <p className="ui-text-muted dota-hint">Добавьте адрес в OBS как Browser Source: 1920 × 1080, прозрачный фон. Работает, пока плагин включён.</p>
      </Panel>
      <Panel title="Горячая клавиша">
        <HotkeyBindRow enableDescription="Показать или скрыть только Dota overlay. Работает при включённом плагине." bindLabel="Видимость overlay" status={hotkey} busy={busy} defaultShortcut="CommandOrControl+Alt+F11" onUpdate={async(enabled,shortcut)=>{await run(async()=>{setHotkey(await invoke<Hotkey>("overlay.hotkey.save",{enabled,shortcut}));setResult("Горячая клавиша сохранена.");});}}/>
      </Panel>
    </div>
    {error&&<p className="ui-notice ui-notice--danger" role="alert">{error}</p>}{result&&<p className="ui-notice ui-notice--success" role="status">{result}</p>}
    <DesignPage/>
  </section>;
}
