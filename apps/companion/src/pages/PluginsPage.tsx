import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Button, Input } from "../components/ui";
import * as api from "../plugins/api";
import { greeting } from "../plugin-lab/bridge";
import { ready as uiReady, request as uiRequest, UI_VERSION } from "../../../../plugins/protocol/ui";
import "./PluginsPage.css";

const phaseText = { running: "Работает", starting: "Запускается", stopped: "Остановлен", failed: "Ошибка процесса" };

export function PluginsPage({ initialPluginId }: { initialPluginId?: string } = {}) {
  const [view, setView] = useState<api.View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState<string | null>(initialPluginId ?? null);
  const [local, setLocal] = useState("");
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    try { const next = await api.view(); if (mounted.current) setView(next); }
    catch (e) { if (mounted.current) setError(api.errorText(e)); }
  }, []);
  useEffect(() => {
    mounted.current = true; void refresh(); let polling = false;
    const timer = window.setInterval(() => {
      if (!polling) { polling = true; void refresh().finally(() => { polling = false; }); }
    }, 700);
    return () => { mounted.current = false; window.clearInterval(timer); };
  }, [refresh]);
  const run = async (task: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await task(); } catch (e) { if (mounted.current) setError(api.errorText(e)); }
    finally { if (mounted.current) { setBusy(false); void refresh(); } }
  };
  const disabled = busy || !!view?.transfer.busy;
  const selected = view?.installed.find((p) => p.id === opened);
  const installButton = (r: api.Release) => {
    const installed = view?.installed.find((p) => p.id === r.manifest.id);
    const current = installed?.installed.active === r.manifest.version || installed?.installed.pending === r.manifest.version;
    const compatible = r.manifest.minApi <= (view?.apiVersion ?? 1) && r.manifest.maxApi >= 1
      && (r.manifest.execution !== "live" || r.manifest.minApi >= 2);
    return <div className="plugin-actions">
      {!compatible && <p role="status">Несовместимая версия API</p>}
      <Button disabled={disabled || current || !compatible} onClick={() => void run(() => api.install(r.manifest.id, r.manifest.version))}>{current ? "Установлен" : installed ? "Обновить" : "Установить"}</Button>
      {view?.localInstallAllowed && <Button disabled={disabled || current || !compatible || !local.trim()} onClick={() => void run(() => api.install(r.manifest.id, r.manifest.version, local.trim()))}>Установить локальный подписанный пакет</Button>}
    </div>;
  };
  return <section className="page-content plugin-library" aria-label="Плагины">
    <header className="plugin-library__heading">
      <div><h2>{selected ? selected.manifest?.name ?? selected.id : "Плагины"}</h2><p>{selected ? "Управление установленным плагином" : "Устанавливайте только нужные расширения Companion."}</p></div>
      <Button disabled={disabled} onClick={() => void run(api.refresh)}>Обновить каталог</Button>
    </header>
    {(error || view?.error) && <p role="alert">{error ?? api.errorText(view?.error)}</p>}
    {!view && !error && <p role="status">Загрузка библиотеки…</p>}
    {view?.catalogError && <p role="status">{api.errorText(view.catalogError)} Установленные плагины доступны независимо от каталога.</p>}
    {view?.transfer.busy && <div className="plugin-transfer" role="status">
      {["activation","operation","file_selection"].includes(view.transfer.stage) ? <p>Выполняется ручная операция плагина…</p> : <>
        <p>{view.transfer.stage === "verify_install" ? "Проверка и установка" : "Загрузка"}: {Math.round(view.transfer.received / 1024)} КБ</p>
        <progress value={view.transfer.total ? view.transfer.received : undefined} max={view.transfer.total ?? 1} />
        <Button onClick={() => void api.cancel().catch((e) => setError(api.errorText(e)))}>Отменить загрузку</Button>
      </>}
    </div>}
    {view?.transfer.error && !error && <p role="alert">{api.errorText(view.transfer.error)}</p>}
    {opened && <Button onClick={() => setOpened(null)}>Все плагины</Button>}
    {opened && view && !selected && <p role="status">Плагин больше не установлен. Пользовательские данные сохранены.</p>}
    {selected ? <article className="plugin-detail">
      <p>{selected.manifest?.description}</p>
      <p>Версия {selected.installed.active} · {selected.installed.enabled ? phaseText[selected.runtime?.phase ?? "stopped"] : "Отключён"}</p>
      <p>{selected.manifest?.author ? `Автор: ${selected.manifest.author}` : "Автор не указан в манифесте."}</p>
      {selected.installed.pending && <p role="status">Обновление {selected.installed.pending} будет активировано после остановки.</p>}
      {(selected.error || selected.runtime?.lastError) && <p role="alert">{api.errorText(selected.error ?? selected.runtime?.lastError)}</p>}
      {selected.manifest?.execution === "live" ? <WorkerControls key={`controls-${selected.id}-${selected.installed.active}`} plugin={selected} disabled={disabled} run={run} /> : <div className="plugin-actions">
        <Button disabled={disabled} onClick={() => void run(() => api.action(selected.id, selected.installed.enabled ? "disable" : "enable"))}>{selected.installed.enabled ? "Отключить" : "Включить"}</Button>
        {selected.installed.enabled && selected.runtime?.phase !== "running" && <Button disabled={disabled} onClick={() => void run(() => api.action(selected.id, "start"))}>Запустить</Button>}
        <Button disabled={disabled || selected.runtime?.phase !== "running"} onClick={() => void run(() => api.action(selected.id, "stop"))}>Остановить</Button>
        {selected.installed.previous && <Button disabled={disabled || selected.runtime?.phase === "running"} onClick={() => void run(() => api.action(selected.id, "rollback"))}>Откатить на {selected.installed.previous}</Button>}
        <Button variant="danger" disabled={disabled} onClick={() => void run(() => api.action(selected.id, "remove"))}>Удалить</Button>
      </div>}
      {view?.catalog.filter((r) => r.manifest.id === selected.id).map((r) => <div key={r.manifest.version}>{installButton(r)}</div>)}
      <small>При удалении пользовательские данные сохраняются.</small>
      {((selected.manifest?.execution === "live" && selected.manifest.minApi>=2)|| (selected.installed.enabled && selected.runtime?.phase === "running")) && <PluginUI key={`ui-${selected.id}-${selected.installed.active}`} plugin={selected} />}
      {selected.manifest?.execution !== "live" && !selected.installed.enabled && <p>Чтобы открыть интерфейс этого плагина, включите его отдельным действием.</p>}
    </article> : !opened && <>
      <h3>Установленные</h3>
      {view && view.installed.length === 0 && <p>Плагины ещё не установлены.</p>}
      <div className="plugin-grid" aria-label="Установленные плагины">
        {view?.installed.map((p) => <article className="plugin-card" key={p.id}>
          <span className="plugin-icon" aria-hidden="true">{(p.manifest?.name ?? p.id).slice(0, 1)}</span>
          <h4>{p.manifest?.name ?? p.id}</h4><p>{p.manifest?.description ?? "Метаданные установленного пакета недоступны."}</p>
          <p>Версия {p.installed.active} · {p.id === "dota2" ? "Статус выполнения — на странице плагина" : p.installed.enabled ? phaseText[p.runtime?.phase ?? "stopped"] : "Отключён"}</p>
          <small>{p.manifest?.author ? `Автор: ${p.manifest.author}` : "Автор не указан в манифесте."}</small>
          {(p.error || p.runtime?.lastError) && <p role="alert">{api.errorText(p.error ?? p.runtime?.lastError)}</p>}
          <Button disabled={disabled} onClick={() => setOpened(p.id)}>Открыть</Button>
        </article>)}
      </div>
      <h3>Каталог</h3>
      {view && view.catalog.length === 0 && <p>{view.catalogError ? "Каталог сейчас недоступен. Установленные плагины показаны выше." : "В каталоге нет пакетов для этой системы."}</p>}
      <div className="plugin-grid" aria-label="Каталог плагинов">
        {view?.catalog.map((r) => <article className="plugin-card" key={`${r.manifest.id}-${r.manifest.version}`}>
          <span className="plugin-icon" aria-hidden="true">{r.manifest.name.slice(0, 1)}</span>
          <h4>{r.manifest.name}</h4><p>{r.manifest.description}</p><p>Версия {r.manifest.version}</p>
          <small>{r.manifest.author ? `Автор: ${r.manifest.author}` : "Автор не указан в манифесте."}</small>{installButton(r)}
        </article>)}
      </div>
    </>}
    {view?.localInstallAllowed && <details><summary>Диагностика установки</summary><label>Путь к пакету для разработки (проверки подписи обязательны)<Input value={local} onChange={(e) => setLocal(e.target.value)} /></label></details>}
  </section>;
}

function WorkerControls({ plugin, disabled, run }: { plugin: api.Installed; disabled: boolean; run: (task: () => Promise<void>) => Promise<void> }) {
  const [confirmed,setConfirmed]=useState(false);
  const [pending,setPending]=useState<string|null>(null);
  const [result,setResult]=useState<string|null>(null);
  const [failure,setFailure]=useState<string|null>(null);
  const inFlight=useRef(false);
  const compatible=(plugin.manifest?.minApi??0)>=2;
  const prepared=plugin.runtime?.phase==="running"&&plugin.runtime.pluginVersion===plugin.installed.active&&!!plugin.runtime.state&&typeof plugin.runtime.state==="object"&&"prepared" in plugin.runtime.state&&plugin.runtime.state.prepared===true;
  const execute=async(action:string)=>{
    if(inFlight.current)return;inFlight.current=true;setPending(action);setFailure(null);setResult(null);
    await run(async()=>{try{
      await api.action(plugin.id,action);
      setResult(action==="prepare"?"Подготовка подтверждена worker: backup проверен, хранилище подготовлено. Плагин ещё не включён.":action==="enable"?"Плагин включён вручную.":"Плагин остановлен. Пользовательские данные сохранены.");
    }catch(e){setFailure(api.errorText(e));throw e;}finally{inFlight.current=false;setPending(null);}});
  };
  return <section aria-label="Управление плагином" aria-busy={pending!==null}>
    {!compatible&&<p role="status">Установленный пакет использует старый API. Для запуска установите совместимое обновление из каталога.</p>}
    {compatible&&!plugin.installed.enabled&&<>
      <label><input type="checkbox" checked={confirmed} disabled={disabled||pending!==null} onChange={e=>setConfirmed(e.target.checked)}/>Разрешаю ручную подготовку хранилища. Перед изменением схемы будет проверен backup; существующие файлы сохраняются.</label>
      {!confirmed&&<p>Подготовка заблокирована до ручного подтверждения.</p>}
      <Button disabled={disabled||pending!==null||!confirmed} onClick={()=>void execute("prepare")}>Подготовить backup и миграцию</Button>
      {!prepared&&<p>Перед включением необходимо подтвердить подготовку хранилища.</p>}
    </>}
    <div className="plugin-actions">
      <Button disabled={disabled||pending!==null||!compatible||(!plugin.installed.enabled&&!prepared)} onClick={()=>void execute(plugin.installed.enabled?"disable":"enable")}>{plugin.installed.enabled?"Отключить":"Включить"}</Button>
      {compatible&&(plugin.error||plugin.runtime?.phase==="failed")&&<Button disabled={disabled||pending!==null} onClick={()=>void execute("recover")}>Проверить остановку и восстановить</Button>}
      <Button variant="danger" disabled={disabled||pending!==null} onClick={()=>void run(()=>api.action(plugin.id,"remove"))}>Удалить</Button>
    </div>
    {pending&&<p role="status">{pending==="prepare"?"Проверка пакета, backup и подготовка хранилища…":"Ожидаем подтверждение native-команды…"}</p>}
    {result&&<p role="status">{result}</p>}{failure&&<p role="alert">{failure}</p>}
    <small>Включение только вручную. После перезапуска приложение не запускает live-плагин автоматически.</small>
  </section>;
}

function PluginUI({ plugin }: { plugin: api.Installed }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState<string | null>(null);
  const policy = JSON.stringify(plugin.manifest?.uiCommands ?? []);
  const legacy = (plugin.manifest?.maxApi ?? 1) < 2;
  useEffect(() => {
    let ready = false; let disposed = false; let pending = false; let lastRequest = 0; let inFlight = 0;
    let instance: string;
    try { instance = Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16).padStart(8,"0")).join(""); }
    catch { setError("Безопасный канал интерфейса недоступен."); return; }
    const commands: string[] = JSON.parse(policy);
    const timeout = window.setTimeout(() => { if (!ready) setError("UI плагина не подтвердил загрузку. Проверьте WebView и CSP."); }, 8000);
    const handler = async (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      if (uiReady(event,frame.current?.contentWindow ?? null)) {
        ready = true; window.clearTimeout(timeout); setError(null);
        frame.current?.contentWindow?.postMessage({type:"plugin-host-ready",version:UI_VERSION,instance,pluginId:plugin.id,pluginVersion:plugin.installed.active},"*"); return;
      }
      if (legacy && event.data?.type === "hello-ui-ready" && event.data.version === 1) { ready = true; window.clearTimeout(timeout); return; }
      const request = uiRequest(event,frame.current?.contentWindow ?? null,instance,commands);
      if (ready && request) {
        const reply = (result: unknown, error?: string) => { if (!disposed) frame.current?.contentWindow?.postMessage({type:"plugin-result",version:UI_VERSION,instance,requestId:request.requestId,ok:!error,result,error},"*"); };
        if (request.requestId <= lastRequest) { reply(null,"stale_ui_request"); return; }
        lastRequest = request.requestId;
        if (inFlight >= 8) { reply(null,"plugin_request_quota"); return; }
        inFlight++;
        try { reply(await api.request(plugin.id,request.name,request.args)); }
        catch (e) { const message = api.errorText(e); reply(null,message); if (!disposed) setError(message); }
        finally { inFlight--; }
        return;
      }
      if (!legacy) return;
      const text = greeting(event, frame.current?.contentWindow ?? null);
      if (!ready || text === null || pending) return;
      pending = true;
      try {
        const result = await api.command(plugin.id, text);
        if (!disposed) frame.current?.contentWindow?.postMessage({ type: "hello-result", result }, "*");
      } catch (e) { if (!disposed) setError(api.errorText(e)); }
      finally { pending = false; }
    };
    window.addEventListener("message", handler);
    frame.current?.contentWindow?.postMessage({type:"plugin-host-probe",version:UI_VERSION},"*");
    return () => { disposed = true; window.clearTimeout(timeout); window.removeEventListener("message", handler); };
  }, [plugin.id,plugin.installed.active,policy,legacy]);
  const relative = plugin.manifest?.ui.replace(/^ui\//, "") ?? "index.html";
  return <div>{error && <p role="alert">{error}</p>}
    <iframe ref={frame} title={plugin.manifest?.name ?? plugin.id} sandbox="allow-scripts" referrerPolicy="no-referrer"
      onLoad={() => frame.current?.contentWindow?.postMessage({type:"plugin-host-probe",version:UI_VERSION},"*")}
      src={convertFileSrc(`${plugin.id}/${plugin.installed.active}/${relative}`, "plugin-ui")} style={{ width: "100%", height: 480 }} />
  </div>;
}
