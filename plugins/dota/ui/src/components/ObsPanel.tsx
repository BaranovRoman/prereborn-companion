import {useEffect,useRef,useState} from "react";
import {invoke} from "../api";
// Must match the signed obsBindings: two scenes since 0.2.3 (draft is shown inside Between Matches).
const scenes=[["betweenMatches","Между матчами"],["gameplay","Игра"]] as const;
interface Settings{configRevision:string;bindings:Record<string,string>;enabled:boolean;connected:boolean;scenes:string[]}
function verified(value:Settings):Settings{
 if(!value||!/^[a-f0-9]{64}$/.test(value.configRevision)||typeof value.enabled!=="boolean"||typeof value.connected!=="boolean"||!Array.isArray(value.scenes)||value.scenes.length>128||value.scenes.some(s=>typeof s!=="string"||s.length>256)||!value.bindings||scenes.some(([key])=>typeof value.bindings[key]!=="string"||value.bindings[key].length>256))throw Error("obs_settings_invalid");return value;
}
export function ObsPanel(){
 const [settings,setSettings]=useState<Settings|null>(null);const [bindings,setBindings]=useState<Record<string,string>>({});const [busy,setBusy]=useState(false);const pending=useRef(false);
 const [error,setError]=useState<string|null>(null);const [result,setResult]=useState<string|null>(null);
 const apply=(value:Settings)=>{const next=verified(value);setSettings(next);setBindings({...next.bindings});return next;};
 async function run(action:()=>Promise<void>){if(pending.current)return;pending.current=true;setBusy(true);setError(null);setResult(null);try{await action();}catch(e){setError(String(e));}finally{pending.current=false;setBusy(false);}}
 useEffect(()=>{let active=true;void invoke<Settings>("obs.settings").then(value=>{if(active)apply(value);}).catch(e=>{if(active)setError(String(e));});return()=>{active=false;};},[]);
 return <section><h2>OBS и игровые сцены</h2><p>Подключение и пароль настраиваются в Companion. Плагин задаёт только игровые соответствия сцен.</p>
  {error&&<p role="alert">{error} Изменение не повторяется автоматически.</p>}{result&&<p role="status">{result}</p>}
  {busy&&<p role="status">Выполняется…</p>}
  {!settings?<p>Настройки OBS ещё не получены.</p>:<>
   <p>{settings.connected?"Список сцен получен от OBS.":"OBS недоступен. Сохранённые сцены доступны; переключение не подтверждено."}</p>
   {!settings.enabled&&<p>Автоматизация OBS выключена. Включите её в разделе OBS Companion, когда настройки будут готовы.</p>}
   <form onSubmit={event=>{event.preventDefault();void run(async()=>{
    const next=Object.fromEntries(scenes.map(([key])=>[key,bindings[key]?.trim()??""]));
    const receipt=verified(await invoke<Settings>("obs.save",{expectedRevision:settings.configRevision,bindings:next}));
    if(scenes.some(([key])=>receipt.bindings[key]!==next[key]))throw Error("obs_saved_mapping_mismatch");
    apply(receipt);setResult("Сопоставление сохранено. Реальное переключение проверяется по состоянию OBS.");
   });}}>
    <div className="abilities">{scenes.map(([key,label])=><label key={key}>{label}<input list="dota-obs-scenes" value={bindings[key]??""} disabled={busy} onChange={event=>setBindings(previous=>({...previous,[key]:event.target.value}))}/></label>)}</div>
    <datalist id="dota-obs-scenes">{settings.scenes.map(name=><option key={name} value={name}/>)}</datalist>
    <button type="submit" disabled={busy||scenes.some(([key])=>!bindings[key]?.trim())}>Сохранить сцены</button>
   </form>
  </>}
  <button disabled={busy} onClick={()=>void run(async()=>{apply(await invoke<Settings>("obs.settings"));})}>Обновить список сцен</button>
  <p>Смена сцены подтверждается свежим ответом OBS. При Unknown команда не отправляется повторно вслепую.</p>
 </section>;
}
