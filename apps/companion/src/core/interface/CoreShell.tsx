import { useCallback,useEffect,useLayoutEffect,useRef,useState } from "react";
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
import { TwitchClipsSettings } from "../../components/TwitchClipsSettings";
import { ChatTtsSettings, SpeechNotifications } from "../../components/settings/ChatTtsSettings";
import { UpdateBanner } from "../../components/UpdateBanner";
import { PluginsPage } from "../../pages/PluginsPage";
import { Badge, Button, Notice, Panel, SettingsGroup, SettingsRow } from "../../components/ui";
import { OutputSettings } from "./OutputSettings";
import { ObsConnectionPage } from "./ObsConnectionPage";
import { useHostStatus } from "./hostStatus";
import { synthesizeSileroTts } from "../api";
import "../../components/ui/ui.css";
import "./CoreShell.css";

type Section="overview"|"chat"|"speech"|"obs"|"plugins"|"settings";
// `width` caps reading width per screen type; "fill" screens own the full
// window height so their one inner list/iframe scrolls instead of the page.
const sections: {id:Section;label:string;symbol:string;description:string;width:"narrow"|"wide"|"full";fill?:boolean}[]=[
  {id:"overview",label:"Обзор",symbol:"◫",description:"Состояние сервисов и последние сообщения чата.",width:"wide"},
  {id:"chat",label:"Чат",symbol:"☰",description:"Сообщения Twitch и управление озвучкой во время эфира.",width:"full",fill:true},
  {id:"speech",label:"Озвучка",symbol:"◖",description:"Устройство вывода, голос озвучки и уведомления.",width:"wide"},
  {id:"obs",label:"OBS",symbol:"▣",description:"Подключение к OBS WebSocket и разрешение автоматизации сцен.",width:"narrow"},
  {id:"plugins",label:"Плагины",symbol:"⊞",description:"",width:"full"},
  {id:"settings",label:"Настройки",symbol:"⚙",description:"Аккаунт, интеграции, горячие клавиши и системные параметры.",width:"wide"},
];
const VOICE_REMINDERS_KEY="companion-system-voice-reminders-v1";
export function CoreShell() {
  const {status,error,refresh}=useHostStatus();
  const {overallVolume,setOverallVolume}=useOverallVolume();
  const chat=useTwitchChatSession(overallVolume);
  const output=useAudioOutputDevice();const autostart=useAutostart();const updater=useUpdater();
  const [section,setSection]=useState<Section>("overview");
  const [diagnosticResult,setDiagnosticResult]=useState<string|null>(null);
  const [diagnosticError,setDiagnosticError]=useState<string|null>(null);
  const [diagnosticBusy,setDiagnosticBusy]=useState(false);
  const [voiceNotifications,setVoiceNotifications]=useState(()=>{try{const raw=localStorage.getItem(VOICE_REMINDERS_KEY);return raw==null||raw==="true";}catch{return true;}});
  const synthesizeNotification=useCallback((text:string)=>synthesizeSileroTts(text,chat.settings.sileroVoice),[chat.settings.sileroVoice]);
  // Core never loads a game catalog, bindings, game hooks or a second Twitch queue.
  useManagedPluginAudio({enabled:true,eventName:"plugin-audio-play",fenceEvent:"plugin-audio-fence",fenceAckCommand:"plugin_audio_fence_ack",synthesize:synthesizeNotification,voiceNotificationsEnabled:voiceNotifications},overallVolume);
  useEffect(()=>{void updater.checkForUpdate();},[]); // same standard updater and signature verification
  const diagnostic=async(command:string)=>{if(diagnosticBusy)return;setDiagnosticBusy(true);setDiagnosticError(null);try{const result=await invoke<unknown>(command);setDiagnosticResult(typeof result==="string"?result:"Операция подтверждена приложением.");}catch(e){setDiagnosticError(String(e));}finally{setDiagnosticBusy(false);}};
  const connection=(state:string|undefined)=>state==="connected"?"Подключён":state==="recovering"||state==="reconnecting"?"Переподключение":state==="unavailable"?"Недоступен":"Ожидание подключения";
  const tone=(state:string|undefined)=>state==="connected"?"success" as const:state==="unavailable"?"danger" as const:"warning" as const;
  const setVoiceReminders=(enabled:boolean)=>{setVoiceNotifications(enabled);try{localStorage.setItem(VOICE_REMINDERS_KEY,String(enabled));}catch{/* The current preference remains applied if persistence is unavailable. */}};
  // One scroll container (main); each section returns to where it was left.
  const main=useRef<HTMLElement>(null);const scrollBySection=useRef<Partial<Record<Section,number>>>({});
  const open=(next:Section)=>{if(main.current)scrollBySection.current[section]=main.current.scrollTop;setSection(next);};
  useLayoutEffect(()=>{main.current?.scrollTo?.({top:scrollBySection.current[section]??0});},[section]);
  const current=sections.find((s)=>s.id===section)!;
  const ttsText=!chat.settings.ttsEnabled?"Выключена":chat.isSpeaking()?"Читает сообщение":"Ожидает сообщения";
  return <div className="companion-root">
    <aside className="companion-sidebar">
      <div className="companion-brand"><span aria-hidden="true">P</span><div><strong>PreReborn</strong><small>Companion</small></div></div>
      <nav aria-label="Разделы приложения">{sections.map((item)=><button key={item.id} title={item.label} aria-current={section===item.id?"page":undefined} onClick={()=>open(item.id)}><span aria-hidden="true">{item.symbol}</span>{item.label}</button>)}</nav>
      <p className="companion-version">{status?.companion_version?`Версия ${status.companion_version}`:"Проверка версии…"}</p>
    </aside>
    <main className="companion-main" ref={main}>
      <div className={`companion-page companion-page--${current.width}${current.fill?" companion-page--fill":""}`}>
      <UpdateBanner state={updater.state} onCheck={()=>void updater.checkForUpdate()} onInstall={()=>void updater.installUpdate()} onRestart={()=>void updater.restartToApply()} onDismiss={updater.dismiss}/>
      {/* No device-change prompt: a chosen device stays chosen; "system default" follows Windows silently. */}
      {/* Plugins render their own heading/toolbar; a second title only costs plugin UI height. */}
      {section!=="plugins"&&<header className="companion-page-heading"><div><h1>{current.label}</h1>{current.description&&<p>{current.description}</p>}</div>
        {section==="overview"&&<Button onClick={()=>open("plugins")}>Библиотека плагинов</Button>}</header>}
      {error&&<Notice tone="danger" action={<Button size="small" onClick={()=>void refresh()}>Повторить</Button>}>Состояние сервисов не получено: {error}</Notice>}
      {section==="overview"&&<div className="core-overview">
        <div className="service-grid" aria-label="Сервисы">
          <section className="service-card">
            <header><h2>Twitch</h2><Badge tone={chat.status?tone(chat.status.state):"default"} dot>{chat.status?connection(chat.status.state):"Проверка…"}</Badge></header>
            <p>{chat.status?connection(chat.status.state):"Проверка подключения…"}{chat.status?.displayName&&` · ${chat.status.displayName}`}</p>
            <Button size="small" onClick={()=>open("chat")}>Открыть чат</Button>
          </section>
          <section className="service-card">
            <header><h2>Озвучка</h2><Badge tone={chat.settings.ttsEnabled?"success":"default"} dot={chat.settings.ttsEnabled}>{chat.settings.ttsEnabled?"Включена":"Выключена"}</Badge></header>
            <p>{ttsText} · {chat.settings.ttsEngine==="silero"?"Silero":"Системный голос"}</p>
            <Button size="small" onClick={()=>open("speech")}>Настроить озвучку</Button>
          </section>
          <section className="service-card">
            <header><h2>OBS</h2><Badge tone={tone(status?.obs_state)} dot>{connection(status?.obs_state)}</Badge></header>
            <p>{status?.obs_streaming===true?"Трансляция идёт":status?.obs_streaming===false?"Трансляция не запущена":"Состояние трансляции неизвестно"} · {status?.obs_config.enabled?"автоматизация разрешена":"автоматизация выключена"}</p>
            <Button size="small" onClick={()=>open("obs")}>Настройки OBS</Button>
          </section>
        </div>
        {chat.error&&<Notice tone="danger">{chat.error}</Notice>}
        <Panel title="Последние сообщения" aside={<Button variant="ghost" size="small" onClick={()=>open("chat")}>Весь чат →</Button>}>
          {chat.status?.messages.length?<ol className="recent-messages">{chat.status.messages.slice(-6).map((m)=><li key={m.id}><strong style={{color:m.color||undefined}}>{m.author}</strong><span>{m.text}</span></li>)}</ol>
            :<p className="ui-text-muted">Сообщений пока нет. Проверьте подключение Twitch или откройте чат.</p>}
        </Panel>
      </div>}
      {section==="chat"&&<TwitchChatPage session={chat} onOpenChatSettings={()=>open("speech")}/>}
      {section==="speech"&&<div className="core-columns">
        <div className="core-column">
          <OutputSettings session={chat} output={output} volume={overallVolume} onVolume={setOverallVolume}/>
          <Panel title="Уведомления"><SpeechNotifications session={chat} voiceNotifications={voiceNotifications} onVoiceNotifications={setVoiceReminders}/></Panel>
        </div>
        <div className="core-column">
          <Panel title="Озвучка чата" description="Чтение сообщений Twitch вслух. Пропуск и остановка — на экране «Чат» и по горячей клавише."><ChatTtsSettings session={chat}/></Panel>
        </div>
      </div>}
      {section==="obs"&&<ObsConnectionPage status={status} refresh={refresh}/>}
      {section==="plugins"&&<PluginsPage/>}
      {section==="settings"&&<div className="core-columns">
        <div className="core-column">
          <AccountForm/>
          <IntegrationsPanel/>
          <Panel title="Система">
            <SettingsGroup>
              <AutostartSetting state={autostart.state} busy={autostart.busy} onChange={(enabled)=>void autostart.setAutostart(enabled)}/>
              <SettingsRow label="Обновления" description={`Стандартный подписанный updater Companion.${status?.companion_version?` Установлена версия ${status.companion_version}.`:""}`}>
                <Button onClick={()=>void updater.checkForUpdate()} disabled={updater.state.phase==="checking"}>{updater.state.phase==="checking"?"Проверка…":"Проверить обновления"}</Button>
              </SettingsRow>
            </SettingsGroup>
          </Panel>
        </div>
        <div className="core-column">
          <TwitchClipsSettings/>
          <Panel title="Горячие клавиши" description="Глобальные сочетания работают, даже когда Companion свёрнут в трей. Клавиша клипа — в блоке «Клипы Twitch»."><HotkeySettings status={chat.skipHotkeyStatus} busy={chat.skipHotkeyBusy} onUpdate={chat.updateSkipHotkey}/></Panel>
          <Panel className="ui-panel--quiet" title="Диагностика" description="Технические данные для разбора проблем. Сведения расширений — на странице плагина.">
            <div className="ui-button-row">
              <Button size="small" disabled={diagnosticBusy} onClick={()=>void diagnostic("diagnostics_start")}>Начать диагностику</Button>
              <Button size="small" disabled={diagnosticBusy} onClick={()=>void diagnostic("diagnostics_stop")}>Остановить диагностику</Button>
              <Button size="small" disabled={diagnosticBusy} onClick={()=>void diagnostic("diagnostics_export")}>Экспортировать диагностику</Button>
              <Button size="small" variant="ghost" disabled={diagnosticBusy} onClick={()=>void diagnostic("open_logs_folder")}>Открыть папку логов</Button>
            </div>
            {diagnosticBusy&&<p className="ui-text-muted" role="status">Выполняется…</p>}
            {diagnosticError&&<Notice tone="danger">{diagnosticError}</Notice>}
            {diagnosticResult&&<Notice tone="success">{diagnosticResult}</Notice>}
          </Panel>
        </div>
      </div>}
      </div>
    </main>
  </div>;
}
