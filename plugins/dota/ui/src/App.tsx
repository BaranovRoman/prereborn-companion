import { useCallback, useEffect, useState } from "react";
import * as api from "./api";
import type { GameSoundCatalog, GameSoundEventKind, GameSoundSettings, ManagedSoundAsset, TrackedHero } from "./services/dotaCompanionApi";
import { ItemsCatalog } from "./components/sounds/ItemsCatalog";
import { SoundBindingRow } from "./components/sounds/SoundBindingRow";
import { HistoryPanel } from "./components/HistoryPanel";

export function Dota() {
  const [tab,setTab] = useState("heroes"); const [query,setQuery] = useState(""); const [hero,setHero] = useState<TrackedHero|null>(null);
  const [catalog,setCatalog] = useState<GameSoundCatalog|null>(null); const [settings,setSettings] = useState<GameSoundSettings|null>(null);
  const [status,setStatus] = useState<api.Status|null>(null); const [history,setHistory] = useState<api.History|null>(null);
  const [gsi,setGsi]=useState<api.GsiInstallation|null>(null);
  const [audioReceipt,setAudioReceipt]=useState<api.AudioReceipt|null>(null);
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
    } catch(e) {if(!disposed) setError(String(e));} finally {polling=false;} };
    void poll();const timer=window.setInterval(() => void poll(),1500);
    return () => {disposed=true;window.clearInterval(timer);};
  },[]);
  useEffect(() => {
    if(tab!=="history")return;let disposed=false;
    void api.invoke<api.History>("history.summary").then(h=>{if(!disposed)setHistory(h);}).catch(e=>{if(!disposed)setError(String(e));});
    return()=>{disposed=true;};
  },[tab,status?.lastSequence,status?.session,status?.streamEnded]);
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
  return <main>
    <header><div><h1>Dota 2</h1><p role="status">{!status?"Подключение к плагину…":!status.active?"Плагин выключен — настройки доступны":status.awaitingSession?"Ожидание игровой сессии · звуки доступны и в опробовании героя":"Плагин работает"}</p></div>
      {status?.gsi&&<span>{status.processed} кадров обработано</span>}</header>
    <nav aria-label="Разделы Dota">{[["heroes","Герои"],["items","Предметы"],["history","История"],["settings","Настройки"]].map(([key,title])=><button aria-current={tab===key?"page":undefined} key={key} onClick={()=>{setTab(key);setError(null);}}>{title}</button>)}</nav>
    {(error||status?.lastError)&&<p role="alert">{error??status?.lastError}</p>}
    {!catalog||!settings?<p role="status">Чтение каталога и сохранённых настроек…</p>:<>
      {tab==="heroes"&&(hero?<section><button onClick={()=>setHero(null)}>← Все герои</button><h2>{hero.displayName}</h2>
        <div className="abilities">{hero.abilities.map(ability=><article key={ability.id}><img src={ability.iconUrl} alt="" width={56} height={56}/><h3>{ability.displayName}</h3>
          {ability.status==="unsupported"?<p>Автоматическое событие не поддерживается{ability.reason?`: ${ability.reason}`:""}</p>:<>
            {ability.status==="experimental"&&<p>Экспериментальное событие{ability.reason?`: ${ability.reason}`:""}</p>}
            <SoundBindingRow eventId={ability.id} kind="abilityCast" masterVolume={settings.masterVolume} binding={settings.bindings.find(b=>b.eventId===ability.id)} assets={settings.assets} onChooseFile={choose} onPreview={preview} onRemove={remove}/>
          </>}</article>)}</div>
      </section>:<section><label>Поиск героя <input value={query} onChange={e=>setQuery(e.target.value)} /></label><div className="hero-grid">{catalog.heroes.filter(h=>`${h.displayName} ${h.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(h=><button key={h.id} onClick={()=>setHero(h)}><img src={h.iconUrl} alt="" loading="lazy" width={72} height={40}/><span>{h.displayName}</span>{h.abilities.some(a=>settings.bindings.some(b=>b.eventId===a.id))&&<small>♪ Настроен звук</small>}</button>)}</div></section>)}
      {tab==="items"&&<ItemsCatalog items={catalog.items} settings={settings} onChooseFile={choose} onPreview={preview} onRemove={remove}/>}
      {tab==="history"&&<HistoryPanel history={history} active={status?.active===true} reload={async()=>setHistory(await api.invoke<api.History>("history.summary"))}/>}
      {tab==="settings"&&<section><h2>Звуковые реакции</h2><label><input type="checkbox" checked={settings.enabled} disabled={busy} onChange={e=>{void run(()=>api.invoke("sound.master",{enabled:e.target.checked,volume:settings.masterVolume})).catch(()=>{});}}/> Включены</label>
        <label>Громкость <input type="range" min="0" max="100" defaultValue={settings.masterVolume} disabled={busy} onPointerUp={e=>{void run(()=>api.invoke("sound.master",{enabled:settings.enabled,volume:Number(e.currentTarget.value)})).catch(()=>{});}} onKeyUp={e=>{if(e.key.startsWith("Arrow"))void run(()=>api.invoke("sound.master",{enabled:settings.enabled,volume:Number(e.currentTarget.value)})).catch(()=>{});}}/></label>
        <p>Звуки используют выбранное в Companion устройство вывода. OBS и трансляция для них не требуются. Удаление привязки сохраняет загруженный файл.</p>
        <h2>Подключение Dota GSI</h2>
        <p>{gsi?.found?`Dota найдена: ${gsi.path}`:gsi?"Установка Dota не найдена автоматически.":"Поиск установки Dota…"}</p>
        {gsi?.found&&<p>{gsi.installed?"Файл GSI найден. Получение кадров проверяется отдельно.":"Файл GSI ещё не создан."}</p>}
        <div className="sound-binding-row__actions">
          <button disabled={busy} onClick={()=>{void run(async()=>setGsi(await api.invoke<api.GsiInstallation>("directory.pick"))).catch(()=>{});}}>Выбрать папку Dota</button>
          <button disabled={busy||!gsi?.found} onClick={()=>{void run(async()=>setGsi(await api.invoke<api.GsiInstallation>("gsi.install"))).catch(()=>{});}}>Настроить GSI</button>
        </div><p>После изменения GSI перезапустите Dota. Адрес приёма остаётся 127.0.0.1:3665; OBS overlay — 127.0.0.1:3666/overlay.</p>
        <details><summary>Диагностика Dota</summary>
          <p>Обработано GSI: {status?.processed??0} · обнаружено звуковых событий: {status?.detectedSounds??0} · подготовлено запросов: {status?.plannedSounds??0} · отброшено при смене контекста: {status?.droppedSoundIntents??0}.</p>
          <p>Последний результат аудио ядра: {audioReceipt?.receipt?.status??"нет подтверждённого admission"}. queued/playing и отправка события не подтверждают завершение воспроизведения.</p>
          <pre>{JSON.stringify({worker:status,audio:audioReceipt},null,2)}</pre>
        </details>
      </section>}
    </>}
  </main>;
}
