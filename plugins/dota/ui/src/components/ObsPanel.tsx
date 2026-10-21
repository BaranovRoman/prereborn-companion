import {useEffect,useRef,useState} from "react";
import {invoke} from "../api";
import {Badge,Button,Field,Input,Panel,Select} from "./ui";
import {View} from "./View";
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
 const offline=!settings||settings.scenes.length===0;
 return <section className="dota-view">
  <View title="OBS и игровые сцены" description="Какую сцену OBS включать в каждом состоянии игры. Подключение и пароль OBS настраиваются в Companion → OBS."/>
  {error&&<p className="ui-notice ui-notice--danger" role="alert">{error} Изменение не повторяется автоматически.</p>}{result&&<p className="ui-notice ui-notice--success" role="status">{result}</p>}
  <Panel title="Сцены" aside={settings&&<>
    <Badge tone={settings.connected?"success":"warning"} dot>{settings.connected?"OBS подключён":"OBS недоступен"}</Badge>
    <Badge tone={settings.enabled?"accent":"default"} dot={settings.enabled}>{settings.enabled?"Автоматизация разрешена":"Автоматизация выключена"}</Badge>
  </>}>
   {busy&&<p className="ui-text-muted" role="status">Выполняется…</p>}
   {!settings?<><p className="ui-text-muted">Настройки OBS ещё не получены.</p><div><Button disabled={busy} onClick={()=>void run(async()=>{apply(await invoke<Settings>("obs.settings"));})}>Обновить список сцен</Button></div></>:<>
    {!settings.connected&&<p className="ui-text-muted">Список сцен от OBS не получен. Сохранённые сцены доступны; переключение не подтверждено.</p>}
    {!settings.enabled&&<p className="ui-notice ui-notice--warning">Автоматизация OBS выключена — сцены не будут переключаться. Разрешите её в Companion → OBS.</p>}
    <form className="obs-scenes" onSubmit={event=>{event.preventDefault();void run(async()=>{
     const next=Object.fromEntries(scenes.map(([key])=>[key,bindings[key]?.trim()??""]));
     const receipt=verified(await invoke<Settings>("obs.save",{expectedRevision:settings.configRevision,bindings:next}));
     if(scenes.some(([key])=>receipt.bindings[key]!==next[key]))throw Error("obs_saved_mapping_mismatch");
     apply(receipt);setResult("Сопоставление сохранено. Реальное переключение проверяется по состоянию OBS.");
    });}}>
     <div className="obs-scenes__grid">{scenes.map(([key,label])=><Field key={key} label={label} hint={key==="betweenMatches"?"Драфт и паузы между играми":"Пока идёт матч"}>
      {offline?<Input value={bindings[key]??""} disabled={busy} placeholder="Название сцены" onChange={event=>setBindings(previous=>({...previous,[key]:event.target.value}))}/>
       :<Select value={bindings[key]??""} disabled={busy} onChange={event=>setBindings(previous=>({...previous,[key]:event.target.value}))}>
        <option value="" disabled>Выберите сцену</option>
        {bindings[key]&&!settings.scenes.includes(bindings[key])&&<option value={bindings[key]}>{bindings[key]} (нет в OBS)</option>}
        {settings.scenes.map(name=><option key={name} value={name}>{name}</option>)}
       </Select>}
     </Field>)}</div>
     <div className="ui-button-row">
      <Button type="submit" variant="primary" disabled={busy||scenes.some(([key])=>!bindings[key]?.trim())}>Сохранить сцены</Button>
      <Button disabled={busy} onClick={()=>void run(async()=>{apply(await invoke<Settings>("obs.settings"));})}>Обновить список сцен</Button>
     </div>
    </form>
   </>}
   <p className="ui-text-muted dota-hint">Смена сцены подтверждается свежим ответом OBS. При неизвестном результате команда не отправляется повторно вслепую.</p>
  </Panel>
 </section>;
}
