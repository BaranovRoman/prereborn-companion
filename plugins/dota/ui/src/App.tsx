import { useCallback, useEffect, useState } from "react";
import * as api from "./api";
import type { GameSoundCatalog, GameSoundEventKind, GameSoundSettings, ManagedSoundAsset, TrackedHero } from "./services/dotaCompanionApi";
import { ItemsCatalog } from "./components/sounds/ItemsCatalog";
import { ItemTracePanel } from "./components/ItemTracePanel";
import { SoundBindingRow } from "./components/sounds/SoundBindingRow";
import { HistoryPanel } from "./components/HistoryPanel";
import { ObsPanel } from "./components/ObsPanel";
import { HeroStatistics } from "./components/HeroStatistics";
import { getHeroById, getHeroByInternalName } from "./services/heroCatalog";
import { HeroesPage } from "./components/HeroesPage";
import { useFavoriteHeroes } from "./hooks/useFavoriteHeroes";
import "./heroes.css";
import { OverlayPanel } from "./components/OverlayPanel";
import { View } from "./components/View";
import { Badge, Button, Panel, RangeField, SettingsGroup, SettingsRow, Switch } from "./components/ui";

export function Dota() {
  const [tab,setTab] = useState("heroes"); const favorites = useFavoriteHeroes(); const [hero,setHero] = useState<TrackedHero|null>(null);
  const [catalog,setCatalog] = useState<GameSoundCatalog|null>(null); const [settings,setSettings] = useState<GameSoundSettings|null>(null);
  const [status,setStatus] = useState<api.Status|null>(null); const [history,setHistory] = useState<api.History|null>(null);
  const [gsi,setGsi]=useState<api.GsiInstallation|null>(null);
  const [sync,setSync]=useState<api.SyncStatus|null>(null);
  const [audioReceipt,setAudioReceipt]=useState<api.AudioReceipt|null>(null);
  const [statusError,setStatusError]=useState<string|null>(null);
  const [error,setError] = useState<string|null>(null); const [busy,setBusy] = useState(false);
  const loadSettings = useCallback(async () => setSettings(await api.settings()),[]);
  useEffect(() => {
    let disposed=false;
    void Promise.all([api.catalog(),api.settings()]).then(([c,s]) => {if (!disposed) {setCatalog(c);setSettings(s);}}).catch(e => {if (!disposed) setError(String(e));});
    let polling=false;
    const poll=async () => {if(polling) return; polling=true; try {
      const s=await api.invoke<api.Status>("status"); if(!disposed) setStatus(s);
      if(s.lastSoundOperation){const receipt=await api.invoke<api.AudioReceipt>("audio.receipt",{operationKey:s.lastSoundOperation});if(!disposed)setAudioReceipt(receipt);}
      else if(!disposed)setAudioReceipt(null);
      if(!disposed)setStatusError(null);
    } catch(e) {if(!disposed) setStatusError(String(e));} finally {polling=false;} };
    void poll();const timer=window.setInterval(() => void poll(),1500);
    return () => {disposed=true;window.clearInterval(timer);};
  },[]);
  useEffect(() => {
    if(tab!=="history")return;let disposed=false;
    void api.invoke<api.History>("history.summary").then(h=>{if(!disposed)setHistory(h);}).catch(e=>{if(!disposed)setError(String(e));});
    void api.invoke<api.SyncStatus>("history.sync").then(s=>{if(!disposed)setSync(s);}).catch(e=>{if(!disposed){setSync(null);setError(String(e));}});
    return()=>{disposed=true;};
  },[tab,status?.lastSequence,status?.session,status?.streamEnded,status?.backendUpdates]);
  useEffect(()=>{
    if(tab!=="settings")return;let disposed=false;
    void api.invoke<api.GsiInstallation>("gsi.find").then(value=>{if(!disposed)setGsi(value);}).catch(e=>{if(!disposed)setError(String(e));});
    return()=>{disposed=true;};
  },[tab]);
  const run=async(action:()=>Promise<unknown>)=>{setBusy(true);setError(null);try{await action();await loadSettings();}catch(e){setError(String(e));throw e;}finally{setBusy(false);}};
  const choose=async(eventId:string,kind:GameSoundEventKind)=>{
    await run(async()=>{const asset=await api.invoke<ManagedSoundAsset>("asset.import");await api.invoke("sound.import",{eventId,kind,asset});});
  };
  const remove=async(eventId:string)=>{await run(()=>api.invoke("sound.remove",{eventId}));};
  const preview=async(assetId:string)=>{
    const asset=settings?.assets.find(a=>a.id===assetId);if(!asset)throw new Error("sound_asset_missing");
    await api.invoke("asset.preview",{fileName:asset.fileName,volume:settings!.masterVolume});
  };
  const tabs:[string,string][]=[["heroes","Герои"],["items","Предметы"],["history","История"],["obs","OBS и сцены"],["overlay","Overlay"],["settings","Настройки"]];
  const tone=statusError?"danger":!status?"default":!status.active?"warning":"success";
  return <main className="dota">
    <header className="dota-bar">
      <nav className="ui-tabs" aria-label="Разделы Dota">{tabs.map(([key,title])=><button className={`ui-tabs__tab${tab===key?" is-active":""}`} aria-current={tab===key?"page":undefined} key={key} onClick={()=>{setTab(key);setError(null);window.scrollTo?.({top:0});}}>{title}</button>)}</nav>
      <p className={`dota-bar__status dota-bar__status--${tone}`} role="status"><span aria-hidden="true" className="dota-bar__dot"/>{statusError?"Состояние плагина не подтверждено":!status?"Подключение к плагину…":!status.active?"Плагин выключен — настройки доступны":status.awaitingSession?"Ожидание игровой сессии · звуки доступны и в опробовании героя":"Плагин работает"}{!statusError&&status?.gsi?` · ${status.processed} кадров`:""}{!statusError&&status?.active&&status.overlayVisible===false?` · оверлей скрыт${status.overlayHotkey?.shortcut?` — ${status.overlayHotkey.shortcut}`:""}`:""}</p>
    </header>
    <div className="dota-alerts">
      {(statusError||error||status?.lastError)&&<p className="ui-notice ui-notice--danger" role="alert">{statusError??error??status?.lastError}</p>}
      {status?.obsError&&<p className="ui-notice ui-notice--warning" role="alert">OBS: {status.obsError}. Выполнение игровых сцен не подтверждено.</p>}
    </div>
    {!catalog||!settings?<p className="dota-loading">Чтение каталога и сохранённых настроек…</p>:<>
      {tab==="heroes"&&(hero?<section className="dota-view hero-detail">
        <div className="dota-view__header"><div className="hero-detail__title"><Button variant="ghost" onClick={()=>setHero(null)}>← Все герои</Button><h2>{hero.displayName}</h2></div></div>
        <div className="hero-detail__body">
          <div className="abilities">{hero.abilities.map(ability=><article key={ability.id} className={`ability-card ability-card--${ability.status}`}>
            <header><img src={ability.iconUrl} alt="" width={48} height={48}/><div><h3>{ability.displayName}</h3>{ability.status==="experimental"&&<Badge tone="warning">Экспериментально</Badge>}</div></header>
            {ability.status==="unsupported"?<p className="ability-card__note">Автоматическое событие не поддерживается{ability.reason?`: ${ability.reason}`:""}</p>:<>
              {ability.status==="experimental"&&ability.reason&&<p className="ability-card__note">{ability.reason}</p>}
              <SoundBindingRow eventId={ability.id} kind="abilityCast" masterVolume={settings.masterVolume} binding={settings.bindings.find(b=>b.eventId===ability.id)} assets={settings.assets} onChooseFile={choose} onPreview={preview} onRemove={remove}/>
            </>}</article>)}</div>
          {getHeroByInternalName(hero.id)&&<HeroStatistics key={hero.id} heroId={getHeroByInternalName(hero.id)!.id}/>}
        </div>
      </section>:<HeroesPage favorites={favorites} soundSettings={settings} trackedHeroes={catalog.heroes} onSelectHero={id=>{const entry=getHeroById(id);const tracked=entry&&catalog.heroes.find(h=>h.id===`npc_dota_hero_${entry.name}`);if(tracked)setHero(tracked);}}/>)}
      {tab==="items"&&<section className="dota-view">
        <View title="Предметы" description="Звук при использовании предмета. Выберите предмет в каталоге — настройки появятся справа."/>
        <ItemTracePanel active={status?.active===true} frames={status?.processed??0}/>
        <ItemsCatalog items={catalog.items} settings={settings} onChooseFile={choose} onPreview={preview} onRemove={remove}/>
      </section>}
      {tab==="history"&&<HistoryPanel history={history} sync={sync} active={status?.active===true} reload={async()=>{setHistory(await api.invoke<api.History>("history.summary"));setSync(await api.invoke<api.SyncStatus>("history.sync"));}}/>}
      {tab==="obs"&&<ObsPanel/>}
      {tab==="overlay"&&<OverlayPanel active={status?.active===true&&!statusError} visible={status?.overlayVisible!==false} reload={async()=>{setStatus(await api.invoke<api.Status>("status"));setStatusError(null);}}/>}
      {tab==="settings"&&<section className="dota-view">
        <View title="Настройки" description="Звуковые реакции и подключение игры."/>
        <div className="dota-columns">
          <Panel title="Звуковые реакции" description="Звуки используют выбранное в Companion устройство вывода. OBS и трансляция для них не требуются.">
            <SoundMaster settings={settings} busy={busy} onSave={(enabled,volume)=>{void run(()=>api.invoke("sound.master",{enabled,volume})).catch(()=>{});}}/>
            <p className="ui-text-muted dota-hint">Удаление привязки сохраняет загруженный файл.</p>
          </Panel>
          <Panel title="Подключение Dota GSI" description="Dota отправляет состояние игры в плагин через Game State Integration."
            aside={<Badge tone={gsi?.installed?"success":gsi?.found?"warning":"default"} dot>{gsi?.installed?"GSI настроен":gsi?.found?"GSI не настроен":"Dota не найдена"}</Badge>}>
            <div className="gsi-state">
              <p>{gsi?.found?`Dota найдена: ${gsi.path}`:gsi?"Установка Dota не найдена автоматически.":"Поиск установки Dota…"}</p>
              {gsi?.found&&<p className="ui-text-muted">{gsi.installed?"Файл GSI найден. Получение кадров проверяется отдельно.":"Файл GSI ещё не создан."}</p>}
            </div>
            <div className="ui-button-row">
              <Button variant={gsi?.found&&!gsi.installed?"primary":"default"} disabled={busy||!gsi?.found} onClick={()=>{void run(async()=>setGsi(await api.invoke<api.GsiInstallation>("gsi.install"))).catch(()=>{});}}>Настроить GSI</Button>
              <Button disabled={busy} onClick={()=>{void run(async()=>setGsi(await api.invoke<api.GsiInstallation>("directory.pick"))).catch(()=>{});}}>Выбрать папку Dota</Button>
            </div>
            <p className="ui-text-muted dota-hint">После изменения GSI перезапустите Dota. Адрес приёма — 127.0.0.1:3665; OBS overlay — 127.0.0.1:3666/overlay.</p>
          </Panel>
        </div>
        <details className="ui-disclosure dota-diagnostics"><summary>Диагностика Dota</summary>
          <div className="ui-disclosure__body">
            <p>Состояние OBS stream: {status?.streaming==null?"неизвестно":status.streaming?"идёт трансляция":"трансляция остановлена"}. {status?.backendError?`Backend: ${status.backendError}`:""} {status?.overlayBackendError?`Overlay backend: ${status.overlayBackendError}`:""}</p>
            <p>Обработано GSI: {status?.processed??0} · обнаружено звуковых событий: {status?.detectedSounds??0} · подготовлено запросов: {status?.plannedSounds??0} · отброшено при смене контекста: {status?.droppedSoundIntents??0}.</p>
            <p>Последний результат аудио ядра: {audioReceipt?.receipt?.status??"нет подтверждённого admission"}. queued/playing и отправка события не подтверждают завершение воспроизведения.</p>
            <pre className="ui-code">{JSON.stringify({worker:status,audio:audioReceipt},null,2)}</pre>
          </div>
        </details>
      </section>}
    </>}
  </main>;
}

// Volume is committed when the drag/arrow key ends (one worker write per
// adjustment), while the number beside the slider follows the thumb.
function SoundMaster({settings,busy,onSave}:{settings:GameSoundSettings;busy:boolean;onSave:(enabled:boolean,volume:number)=>void}){
  const [volume,setVolume]=useState(settings.masterVolume);
  useEffect(()=>setVolume(settings.masterVolume),[settings.masterVolume]);
  return <SettingsGroup>
    <SettingsRow label="Звуковые реакции" description="Звуки способностей и предметов во время игры">
      <Switch aria-label="Звуковые реакции включены" checked={settings.enabled} disabled={busy} onChange={e=>onSave(e.target.checked,settings.masterVolume)}/>
    </SettingsRow>
    <SettingsRow label="Громкость" description="Общая громкость звуков Dota">
      <span className="dota-volume"><RangeField aria-label="Громкость" display={`${volume}%`} min={0} max={100} value={volume} disabled={busy}
        onChange={e=>setVolume(Number(e.target.value))}
        onPointerUp={e=>onSave(settings.enabled,Number(e.currentTarget.value))}
        onKeyUp={e=>{if(e.key.startsWith("Arrow"))onSave(settings.enabled,Number(e.currentTarget.value));}}/></span>
    </SettingsRow>
  </SettingsGroup>;
}
