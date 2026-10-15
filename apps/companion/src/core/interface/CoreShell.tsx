import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTwitchChatSession } from "../../chat/useTwitchChatSession";
import { useOverallVolume } from "../../hooks/useOverallVolume";
import { useAudioOutputDevice } from "../../hooks/useAudioOutputDevice";
import { useAutostart } from "../../hooks/useAutostart";
import { useUpdater } from "../../hooks/useUpdater";
import { useManagedPluginAudio } from "../audio/useManagedPluginAudio";
import { AccountForm } from "../../components/AccountForm";
import { AutostartSetting } from "../../components/AutostartSetting";
import { HotkeySettings } from "../../components/HotkeySettings";
import { IntegrationsPanel } from "../../components/IntegrationsPanel";
import { TwitchChatPage } from "../../components/TwitchChatPage";
import { ChatTtsSettings } from "../../components/settings/ChatTtsSettings";
import { UpdateBanner } from "../../components/UpdateBanner";
import { AudioDeviceChangeBanner } from "../../components/AudioDeviceChangeBanner";
import { PluginsPage } from "../../pages/PluginsPage";
import { Button } from "../../components/ui";
import { OutputSettings } from "./OutputSettings";
import { ObsConnectionPage } from "./ObsConnectionPage";
import { useHostStatus } from "./hostStatus";
import "./CoreShell.css";

type Section="overview"|"chat"|"speech"|"obs"|"plugins"|"settings";
const sections: {id:Section;label:string;symbol:string}[]=[
  {id:"overview",label:"Обзор",symbol:"◫"},{id:"chat",label:"Чат",symbol:"☰"},
  {id:"speech",label:"Озвучка",symbol:"◖"},{id:"obs",label:"OBS",symbol:"▣"},
  {id:"plugins",label:"Плагины",symbol:"⊞"},{id:"settings",label:"Настройки",symbol:"⚙"},
];
export function CoreShell() {
  const {status,error,refresh}=useHostStatus();
  const {overallVolume,setOverallVolume}=useOverallVolume();
  const chat=useTwitchChatSession(overallVolume);
  const output=useAudioOutputDevice();const autostart=useAutostart();const updater=useUpdater();
  const [section,setSection]=useState<Section>("overview");
  const [diagnosticResult,setDiagnosticResult]=useState<string|null>(null);
  const [diagnosticError,setDiagnosticError]=useState<string|null>(null);
  const [diagnosticBusy,setDiagnosticBusy]=useState(false);
  // The legacy event names are transport aliases until the worker migration completes.
  // Core never loads a game catalog, bindings, game hooks or a second Twitch queue.
  useManagedPluginAudio({enabled:true,eventName:"game-sound-play",fenceEvent:"game-audio-fence",fenceAckCommand:"game_audio_fence_ack"},overallVolume);
  useEffect(()=>{void updater.checkForUpdate();},[]); // same standard updater and signature verification
  const diagnostic=async(command:string)=>{if(diagnosticBusy)return;setDiagnosticBusy(true);setDiagnosticError(null);try{const result=await invoke<unknown>(command);setDiagnosticResult(typeof result==="string"?result:"Операция подтверждена приложением.");}catch(e){setDiagnosticError(String(e));}finally{setDiagnosticBusy(false);}};
  const connection=(state:string|undefined)=>state==="connected"?"Подключён":state==="recovering"||state==="reconnecting"?"Переподключение":state==="unavailable"?"Недоступен":"Ожидание подключения";
  return <div className="companion-root">
    <aside className="companion-sidebar">
      <div className="companion-brand"><span aria-hidden="true">P</span><div><strong>PreReborn</strong><small>Companion</small></div></div>
      <nav aria-label="Разделы приложения">{sections.map((item)=><button key={item.id} aria-current={section===item.id?"page":undefined} onClick={()=>setSection(item.id)}><span aria-hidden="true">{item.symbol}</span>{item.label}</button>)}</nav>
      <p className="companion-version">{status?.companion_version?`Версия ${status.companion_version}`:"Проверка версии…"}</p>
    </aside>
    <main className="companion-main">
      <UpdateBanner state={updater.state} onCheck={()=>void updater.checkForUpdate()} onInstall={()=>void updater.installUpdate()} onRestart={()=>void updater.restartToApply()} onDismiss={updater.dismiss}/>
      <AudioDeviceChangeBanner toLabel={output.switchPrompt?.toLabel??null} onSwitch={output.onSwitchToNewDefault} onKeep={output.onKeepCurrentDevice}/>
      <header className="companion-page-heading"><div><p className="core-eyebrow">COMPANION</p><h1>{sections.find((s)=>s.id===section)?.label}</h1></div></header>
      {error&&<p className="core-notice" role="alert">Состояние сервисов не получено: {error} <button onClick={()=>void refresh()}>Повторить</button></p>}
      {section==="overview"&&<section className="core-overview">
        <h2>Сервисы</h2>
        <dl className="core-service-list">
          <div><dt>Twitch</dt><dd>{chat.status?connection(chat.status.state):"Проверка подключения…"}{chat.status?.displayName&&` · ${chat.status.displayName}`}</dd></div>
          <div><dt>Озвучка</dt><dd>{!chat.settings.ttsEnabled?"Выключена":chat.isSpeaking()?"Читает сообщение":"Ожидает сообщения"} · {chat.settings.ttsEngine==="silero"?"Silero":"Системный голос"}</dd></div>
          <div><dt>OBS</dt><dd>{connection(status?.obs_state)}{status?.obs_streaming===true?" · Трансляция идёт":status?.obs_streaming===false?" · Трансляция не запущена":""}</dd></div>
        </dl>
        {chat.error&&<p role="alert">{chat.error}</p>}
        <div className="core-actions"><Button onClick={()=>setSection("chat")}>Открыть чат</Button><Button onClick={()=>setSection("speech")}>Настроить озвучку</Button><Button onClick={()=>setSection("plugins")}>Библиотека плагинов</Button></div>
        <section className="core-recent"><h2>Последние сообщения</h2>{chat.status?.messages.length?<ol>{chat.status.messages.slice(-5).map((m)=><li key={m.id}><strong>{m.author}</strong><p>{m.text}</p></li>)}</ol>:<p className="core-hint">Сообщений пока нет. Проверьте подключение Twitch или откройте чат.</p>}</section>
      </section>}
      {section==="chat"&&<TwitchChatPage session={chat} onOpenChatSettings={()=>setSection("speech")}/>}
      {section==="speech"&&<div className="core-settings-stack"><OutputSettings session={chat} output={output} volume={overallVolume} onVolume={setOverallVolume}/><section className="core-settings-group"><h2>Чат и озвучка</h2><ChatTtsSettings session={chat}/></section></div>}
      {section==="obs"&&<ObsConnectionPage status={status} refresh={refresh}/>}
      {section==="plugins"&&<PluginsPage/>}
      {section==="settings"&&<div className="core-settings-stack">
        <section className="core-settings-group"><AccountForm/></section>
        <section className="core-settings-group"><IntegrationsPanel/></section>
        <section className="core-settings-group"><AutostartSetting state={autostart.state} busy={autostart.busy} onChange={(enabled)=>void autostart.setAutostart(enabled)}/></section>
        <section className="core-settings-group"><HotkeySettings status={chat.skipHotkeyStatus} busy={chat.skipHotkeyBusy} onUpdate={chat.updateSkipHotkey}/></section>
        <section className="core-settings-group"><h2>Обновления</h2><p>Используется стандартный подписанный updater Companion.</p><Button onClick={()=>void updater.checkForUpdate()} disabled={updater.state.phase==="checking"}>Проверить обновления</Button></section>
        <section className="core-settings-group"><h2>Диагностика</h2><div className="core-actions"><Button disabled={diagnosticBusy} onClick={()=>void diagnostic("open_logs_folder")}>Открыть папку логов</Button><Button disabled={diagnosticBusy} onClick={()=>void diagnostic("diagnostics_start")}>Начать диагностику</Button><Button disabled={diagnosticBusy} onClick={()=>void diagnostic("diagnostics_stop")}>Остановить диагностику</Button><Button disabled={diagnosticBusy} onClick={()=>void diagnostic("diagnostics_export")}>Экспортировать диагностику</Button></div>{diagnosticBusy&&<p role="status">Выполняется…</p>}{diagnosticError&&<p role="alert">{diagnosticError}</p>}{diagnosticResult&&<p role="status">{diagnosticResult}</p>}<p className="core-hint">Технические сведения расширения доступны на его странице.</p></section>
      </div>}
    </main>
  </div>;
}
