import { useEffect, useRef, useState } from "react";
import { Badge, Button, Field, Input, Notice, Panel, SettingsRow, Switch } from "../../components/ui";
import { checkObsConnection, saveObsConnection, type HostStatus } from "./hostStatus";

export function ObsConnectionPage({status,refresh}: {status:HostStatus|null;refresh:()=>Promise<void>}) {
  const [host,setHost]=useState("");const [port,setPort]=useState("4455");const [password,setPassword]=useState("");
  const [enabled,setEnabled]=useState(false);const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);const [message,setMessage]=useState<string|null>(null);const [scenes,setScenes]=useState<string[]|null>(null);
  const dirty=useRef(false);
  useEffect(()=>{if(status&&!dirty.current){setHost(status.obs_config.host);setPort(String(status.obs_config.port));setEnabled(status.obs_config.enabled);}},[status]);
  const run=async(task:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError(null);setMessage(null);try{await task();}catch(e){setError(String(e));}finally{setBusy(false);}};
  const locked=busy||!status;
  // Connection and automation are separate facts: a connected OBS is not
  // permission to switch scenes, and permission without a connection does nothing.
  const automation=status?.obs_config.enabled;
  return <div className="obs-page">
    <Panel title="Подключение OBS" description="Companion подключается к OBS по WebSocket (OBS → Инструменты → Настройки сервера WebSocket)."
      aside={<>
        <Badge tone={status?.obs_connected?"success":"warning"} dot>{status?.obs_connected?"WebSocket подключён":"Подключение не подтверждено"}</Badge>
        <Badge tone={automation?"accent":"default"} dot={!!automation}>{automation?"Автоматизация разрешена":"Автоматизация выключена"}</Badge>
      </>}>
      <form className="obs-form" onSubmit={(e)=>{e.preventDefault();void run(async()=>{
        if(!status)throw new Error("Состояние подключения ещё не получено.");
        const parsed=Number(port);if(!Number.isInteger(parsed)||parsed<1||parsed>65535)throw new Error("Порт должен быть от 1 до 65535.");
        await saveObsConnection({...status.obs_config,host:host.trim(),port:parsed,password,enabled});
        setPassword("");dirty.current=false;await refresh();setMessage("Настройки сохранены. Доступность OBS проверяется отдельно.");
      });}}>
        <div className="obs-form__grid">
          <Field label="Адрес"><Input value={host} onChange={(e)=>{dirty.current=true;setHost(e.target.value);}} disabled={locked}/></Field>
          <Field label="Порт"><Input value={port} inputMode="numeric" onChange={(e)=>{dirty.current=true;setPort(e.target.value);}} disabled={locked}/></Field>
          <Field label="Пароль WebSocket"><Input type="password" value={password} autoComplete="off" placeholder="Без изменений" onChange={(e)=>{dirty.current=true;setPassword(e.target.value);}} disabled={locked}/></Field>
        </div>
        <div className="obs-form__automation">
          <SettingsRow label="Разрешить автоматизацию OBS" description="Плагины смогут переключать сцены (например, «Между матчами» и «Игра» в Dota). Без разрешения Companion только читает состояние OBS.">
            <Switch aria-label="Разрешить автоматизацию OBS" checked={enabled} disabled={locked} onChange={(e)=>{dirty.current=true;setEnabled(e.target.checked);}}/>
          </SettingsRow>
        </div>
        <div className="ui-button-row">
          <Button type="submit" variant="primary" disabled={locked}>{busy?"Выполняется…":"Сохранить"}</Button>
          <Button disabled={locked} onClick={()=>void run(async()=>{const next=await checkObsConnection();setScenes(next);await refresh();setMessage("Подключение проверено. Список сцен получен от OBS.");})}>Проверить подключение</Button>
          <span className="ui-text-muted obs-form__hint">Пустой пароль сохраняет текущий.</span>
        </div>
      </form>
      {error&&<Notice tone="danger">{error}</Notice>}
      {message&&<Notice tone="success">{message}</Notice>}
      {status?.obs_last_error&&<Notice tone="warning">{status.obs_last_error}</Notice>}
    </Panel>
    <Panel title="Сцены OBS" description="Список приходит от OBS при проверке подключения. Соответствия сцен задаются в плагинах."
      aside={<Button size="small" disabled={locked} onClick={()=>void run(async()=>{setScenes(await checkObsConnection());})}>Обновить список сцен</Button>}>
      {!scenes?<p className="ui-text-muted">Нажмите «Обновить список сцен», чтобы получить сцены от OBS.</p>
        :scenes.length?<ul className="obs-scene-list" aria-label="Доступные сцены">{scenes.map((scene)=><li key={scene}>{scene}</li>)}</ul>
        :<p className="ui-text-muted">OBS не вернул сцен.</p>}
    </Panel>
  </div>;
}
