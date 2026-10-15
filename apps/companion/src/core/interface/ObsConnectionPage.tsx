import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui";
import { checkObsConnection, saveObsConnection, type HostStatus } from "./hostStatus";

export function ObsConnectionPage({status,refresh}: {status:HostStatus|null;refresh:()=>Promise<void>}) {
  const [host,setHost]=useState("");const [port,setPort]=useState("4455");const [password,setPassword]=useState("");
  const [enabled,setEnabled]=useState(false);const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);const [message,setMessage]=useState<string|null>(null);const [scenes,setScenes]=useState<string[]|null>(null);
  const dirty=useRef(false);
  useEffect(()=>{if(status&&!dirty.current){setHost(status.obs_config.host);setPort(String(status.obs_config.port));setEnabled(status.obs_config.enabled);}},[status]);
  const run=async(task:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError(null);setMessage(null);try{await task();}catch(e){setError(String(e));}finally{setBusy(false);}};
  return <section className="core-settings-group">
    <h2>Подключение OBS</h2><p>OBS WebSocket · {status?.obs_connected?"подключён":"подключение не подтверждено"}</p>
    <form onSubmit={(e)=>{e.preventDefault();void run(async()=>{
      if(!status)throw new Error("Состояние подключения ещё не получено.");
      const parsed=Number(port);if(!Number.isInteger(parsed)||parsed<1||parsed>65535)throw new Error("Порт должен быть от 1 до 65535.");
      await saveObsConnection({...status.obs_config,host:host.trim(),port:parsed,password,enabled});
      setPassword("");dirty.current=false;await refresh();setMessage("Настройки сохранены. Доступность OBS проверяется отдельно.");
    });}}>
      <div className="core-form-grid">
        <label>Адрес<input value={host} onChange={(e)=>{dirty.current=true;setHost(e.target.value);}} disabled={busy||!status}/></label>
        <label>Порт<input value={port} inputMode="numeric" onChange={(e)=>{dirty.current=true;setPort(e.target.value);}} disabled={busy||!status}/></label>
      </div>
      <label>Пароль WebSocket<input type="password" value={password} autoComplete="off" placeholder="Оставьте пустым, чтобы сохранить текущий" onChange={(e)=>{dirty.current=true;setPassword(e.target.value);}} disabled={busy||!status}/></label>
      <label className="core-checkbox"><input type="checkbox" checked={enabled} disabled={busy||!status} onChange={(e)=>{dirty.current=true;setEnabled(e.target.checked);}}/>Разрешить автоматизацию OBS</label>
      <div className="core-actions"><Button type="submit" disabled={busy||!status}>{busy?"Выполняется…":"Сохранить"}</Button><Button disabled={busy||!status} onClick={()=>void run(async()=>{const next=await checkObsConnection();setScenes(next);await refresh();setMessage("Подключение проверено. Список сцен получен от OBS.");})}>Проверить подключение</Button></div>
    </form>
    {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
    {status?.obs_last_error&&<p role="status">{status.obs_last_error}</p>}
    {scenes&&<section><h3>Доступные сцены</h3>{scenes.length?<ul className="core-scene-list">{scenes.map((scene)=><li key={scene}>{scene}</li>)}</ul>:<p>OBS не вернул сцен.</p>}</section>}
  </section>;
}
