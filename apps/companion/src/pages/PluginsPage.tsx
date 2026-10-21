import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Badge, Button, Checkbox, Field, Input, Notice } from "../components/ui";
import * as api from "../plugins/api";
import { greeting } from "../plugins/helloBridge";
import { ready as uiReady, request as uiRequest, UI_VERSION } from "../../../../plugins/protocol/ui";
import "./PluginsPage.css";

// convertFileSrc percent-encodes the whole argument (`/` becomes %2F), which
// breaks the protocol's id/version/asset routing and relative module URLs.
// Take only its platform base and keep real path separators.
function pluginAsset(id: string, version: string, relative: string) {
  const base = convertFileSrc("", "plugin-ui").replace(/\/?$/, "/");
  return base + [id, version, ...relative.split("/")].map(encodeURIComponent).join("/");
}

// Installed packages only: the core serves just the signed, hash-checked
// manifest icon (PNG/WebP). Catalog entries and any failure keep the monogram.
function PluginIcon({ plugin }: { plugin: api.Installed }) {
  const [failed, setFailed] = useState(false);
  const icon = plugin.manifest?.icon;
  const letter = (plugin.manifest?.name ?? plugin.id).slice(0, 1);
  if (!icon?.startsWith("ui/") || failed) return <span className="plugin-icon" aria-hidden="true">{letter}</span>;
  return <img className="plugin-icon" alt="" aria-hidden="true" src={pluginAsset(plugin.id, plugin.installed.active, icon.slice(3))} onError={() => setFailed(true)} />;
}

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
  // One message is shown once: the plugin's own error owns it, so the page
  // banner and the controls drop an identical copy.
  const pluginAlert = selected && (selected.error || selected.runtime?.lastError) ? api.errorText(selected.error ?? selected.runtime?.lastError) : null;
  const pageAlert = error ?? (view?.error ? api.errorText(view.error) : null);
  const isCompatible = (r: api.Release) => r.manifest.minApi <= (view?.apiVersion ?? 1) && r.manifest.maxApi >= 1
    && (r.manifest.execution !== "live" || r.manifest.minApi >= 2);
  const installButton = (r: api.Release, variant: "default" | "primary" = "default") => {
    const installed = view?.installed.find((p) => p.id === r.manifest.id);
    const current = installed?.installed.active === r.manifest.version || installed?.installed.pending === r.manifest.version;
    const compatible = isCompatible(r);
    return <div className="plugin-actions">
      <Button variant={variant} disabled={disabled || current || !compatible} onClick={() => void run(() => api.install(r.manifest.id, r.manifest.version))}>{current ? "Установлен" : installed ? `Обновить до ${r.manifest.version}` : "Установить"}</Button>
      {view?.localInstallAllowed && <Button disabled={disabled || current || !compatible || !local.trim()} onClick={() => void run(() => api.install(r.manifest.id, r.manifest.version, local.trim()))}>Установить локальный подписанный пакет</Button>}
      {!compatible && <Badge tone="warning">Несовместимая версия API</Badge>}
    </div>;
  };
  // An installed plugin is not listed again in the catalog; a different
  // catalog version of it is offered on its own card instead.
  const updatesFor = (id: string) => view?.catalog.filter((r) => r.manifest.id === id && r.manifest.version !== view.installed.find((p) => p.id === id)?.installed.active && r.manifest.version !== view.installed.find((p) => p.id === id)?.installed.pending) ?? [];
  const available = view?.catalog.filter((r) => !view.installed.some((p) => p.id === r.manifest.id)) ?? [];
  const stateTone = (p: api.Installed) => api.needsRecovery(p) || p.runtime?.phase === "failed" ? "danger" as const : !p.installed.enabled ? "default" as const : p.runtime?.phase === "running" ? "success" as const : "warning" as const;
  return <section className="page-content plugin-library" aria-label="Плагины">
    {!selected && <header className="companion-page-heading">
      <div><h1>Плагины</h1><p>Устанавливайте только нужные расширения Companion. Каждый плагин работает в изолированном окружении.</p></div>
      <Button disabled={disabled} onClick={() => void run(api.refresh)}>Обновить каталог</Button>
    </header>}
    {pageAlert && pageAlert !== pluginAlert && <Notice tone="danger">{pageAlert}</Notice>}
    {!view && !error && <p className="ui-text-muted" role="status">Загрузка библиотеки…</p>}
    {view?.catalogError && <Notice tone="warning">{api.errorText(view.catalogError)} Установленные плагины доступны независимо от каталога.</Notice>}
    {view?.transfer.busy && <div className="plugin-transfer" role="status">
      {["activation","operation","file_selection"].includes(view.transfer.stage) ? <p>Выполняется ручная операция плагина…</p> : <>
        <p>{view.transfer.stage === "verify_install" ? "Проверка и установка" : "Загрузка"}: {Math.round(view.transfer.received / 1024)} КБ</p>
        <progress value={view.transfer.total ? view.transfer.received : undefined} max={view.transfer.total ?? 1} />
        <Button size="small" onClick={() => void api.cancel().catch((e) => setError(api.errorText(e)))}>Отменить загрузку</Button>
      </>}
    </div>}
    {view?.transfer.error && !error && api.errorText(view.transfer.error) !== pluginAlert && <Notice tone="danger">{api.errorText(view.transfer.error)}</Notice>}
    {opened && !selected && <div><Button variant="ghost" onClick={() => setOpened(null)}>← Все плагины</Button></div>}
    {opened && view && !selected && <Notice>Плагин больше не установлен. Пользовательские данные сохранены.</Notice>}
    {selected ? <article className="plugin-detail">
      <div className="plugin-toolbar">
        <Button variant="ghost" aria-label="Все плагины" onClick={() => setOpened(null)}>← Все плагины</Button>
        <span className="plugin-toolbar__divider" aria-hidden="true" />
        <PluginIcon plugin={selected} />
        <div className="plugin-toolbar__title"><h2>{selected.manifest?.name ?? selected.id}</h2>
          <span><Badge tone={stateTone(selected)} dot>{api.stateText(selected)}</Badge> v{selected.installed.active}{selected.manifest?.author ? ` · ${selected.manifest.author}` : ""}</span></div>
        {selected.manifest?.execution === "live" ? <WorkerControls key={`controls-${selected.id}-${selected.installed.active}`} plugin={selected} disabled={disabled} run={run} shown={pluginAlert} /> : <div className="plugin-actions">
          <Button disabled={disabled} onClick={() => void run(() => api.action(selected.id, selected.installed.enabled ? "disable" : "enable"))}>{selected.installed.enabled ? "Отключить" : "Включить"}</Button>
          {selected.installed.enabled && selected.runtime?.phase !== "running" && <Button disabled={disabled} onClick={() => void run(() => api.action(selected.id, "start"))}>Запустить</Button>}
          <Button disabled={disabled || selected.runtime?.phase !== "running"} onClick={() => void run(() => api.action(selected.id, "stop"))}>Остановить</Button>
          {selected.installed.previous && <Button disabled={disabled || selected.runtime?.phase === "running"} onClick={() => void run(() => api.action(selected.id, "rollback"))}>Откатить на {selected.installed.previous}</Button>}
        </div>}
        {view?.catalog.filter((r) => r.manifest.id === selected.id && r.manifest.version !== selected.installed.active).map((r) => <div key={r.manifest.version}>{installButton(r)}</div>)}
        <details className="ui-disclosure plugin-about"><summary>О плагине</summary>
          <div className="plugin-about__body">
            <p>{selected.manifest?.description}</p>
            <small className="ui-text-muted">При удалении пользовательские данные сохраняются. Включение только вручную: после перезапуска приложение не запускает live-плагин автоматически.</small>
            <div className="plugin-actions"><Button variant="danger" size="small" disabled={disabled} onClick={() => void run(() => api.action(selected.id, "remove"))}>Удалить</Button></div>
            {(selected.transport!=null||selected.error)&&<pre className="ui-code">{JSON.stringify({error:selected.error,runtime:selected.runtime,transport:selected.transport},null,2)}</pre>}
          </div>
        </details>
      </div>
      {selected.installed.pending && <Notice action={<Button size="small" variant="primary" disabled={disabled} onClick={() => void run(async () => { const enabled = selected.installed.enabled; await api.action(selected.id, "stop"); if (enabled) await api.action(selected.id, "enable"); })}>Перезапустить на {selected.installed.pending}</Button>}>
        Установлена версия {selected.installed.pending}; сейчас работает {selected.installed.active}.
      </Notice>}
      {pluginAlert && <Notice tone="danger">{pluginAlert}</Notice>}
      {((selected.manifest?.execution === "live" && selected.manifest.minApi>=2)|| (selected.installed.enabled && selected.runtime?.phase === "running")) && <PluginUI key={`ui-${selected.id}-${selected.installed.active}`} plugin={selected} />}
      {selected.manifest?.execution !== "live" && !selected.installed.enabled && <p className="ui-text-muted">Чтобы открыть интерфейс этого плагина, включите его отдельным действием.</p>}
    </article> : !opened && <>
      <section className="plugin-section">
        <h2>Установленные</h2>
        {view && view.installed.length === 0 && <p className="ui-text-muted">Плагины ещё не установлены. Выберите нужные в каталоге ниже.</p>}
        <div className="plugin-grid" aria-label="Установленные плагины">
          {view?.installed.map((p) => <article className="plugin-card" key={p.id}>
            <header className="plugin-card__header">
              <PluginIcon plugin={p} />
              <div className="plugin-card__title"><h3>{p.manifest?.name ?? p.id}</h3><span>v{p.installed.active}{p.manifest?.author ? ` · ${p.manifest.author}` : ""}</span></div>
              <Badge tone={stateTone(p)} dot>{api.stateText(p)}</Badge>
            </header>
            <p className="plugin-card__description">{p.manifest?.description ?? "Метаданные установленного пакета недоступны."}</p>
            {(p.error || p.runtime?.lastError) && <p className="plugin-card__error" role="alert">{api.errorText(p.error ?? p.runtime?.lastError)}</p>}
            <footer className="plugin-card__footer">
              <Button variant="primary" disabled={disabled} onClick={() => setOpened(p.id)}>Открыть</Button>
              {updatesFor(p.id).map((r) => <div key={r.manifest.version}>{installButton(r)}</div>)}
            </footer>
          </article>)}
        </div>
      </section>
      <section className="plugin-section">
        <h2>Каталог</h2>
        {view && view.catalog.length === 0 && <p className="ui-text-muted">{view.catalogError ? "Каталог сейчас недоступен. Установленные плагины показаны выше." : "В каталоге нет пакетов для этой системы."}</p>}
        {view && view.catalog.length > 0 && available.length === 0 && <p className="ui-text-muted">Все плагины из каталога уже установлены.</p>}
        <div className="plugin-grid" aria-label="Каталог плагинов">
          {available.map((r) => <article className="plugin-card" key={`${r.manifest.id}-${r.manifest.version}`}>
            <header className="plugin-card__header">
              <span className="plugin-icon" aria-hidden="true">{r.manifest.name.slice(0, 1)}</span>
              <div className="plugin-card__title"><h3>{r.manifest.name}</h3><span>v{r.manifest.version}{r.manifest.author ? ` · ${r.manifest.author}` : ""}</span></div>
            </header>
            <p className="plugin-card__description">{r.manifest.description}</p>
            <footer className="plugin-card__footer">{installButton(r)}</footer>
          </article>)}
        </div>
      </section>
    </>}
    {view?.localInstallAllowed && <details className="ui-disclosure"><summary>Диагностика установки</summary><div className="ui-disclosure__body"><Field label="Путь к пакету для разработки (проверки подписи обязательны)"><Input value={local} onChange={(e) => setLocal(e.target.value)} /></Field></div></details>}
  </section>;
}

function WorkerControls({ plugin, disabled, run, shown }: { plugin: api.Installed; disabled: boolean; run: (task: () => Promise<void>) => Promise<void>; shown: string | null }) {
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
      setResult(action==="prepare"?"Подготовка подтверждена worker: backup проверен, хранилище подготовлено. Плагин ещё не включён.":action==="enable"?"Плагин включён вручную.":action==="recover"?"Остановка предыдущего процесса подтверждена, состояние восстановлено. Плагин можно подготовить и включить.":"Плагин остановлен. Пользовательские данные сохранены.");
    }catch(e){setFailure(api.errorText(e));}finally{inFlight.current=false;setPending(null);}});
  };
  return <section className="plugin-controls" aria-label="Управление плагином" aria-busy={pending!==null}>
    {!compatible&&<Notice tone="warning">Установленный пакет использует старый API. Для запуска установите совместимое обновление из каталога.</Notice>}
    {compatible&&!plugin.installed.enabled&&!prepared&&<div className="plugin-prepare">
      <Checkbox checked={confirmed} disabled={disabled||pending!==null} onChange={e=>setConfirmed(e.target.checked)} label="Разрешаю первую подготовку хранилища" hint="Backup проверяется, файлы сохраняются"/>
      <Button disabled={disabled||pending!==null||!confirmed} onClick={()=>void execute("prepare")}>Подготовить backup и миграцию</Button>
    </div>}
    <div className="plugin-actions">
      <Button variant={plugin.installed.enabled?undefined:"primary"} disabled={disabled||pending!==null||!compatible||(!plugin.installed.enabled&&!prepared)} onClick={()=>void execute(plugin.installed.enabled?"disable":"enable")}>{plugin.installed.enabled?"Отключить":"Включить"}</Button>
      {compatible&&(plugin.error||api.needsRecovery(plugin))&&<Button disabled={disabled||pending!==null} onClick={()=>void execute("recover")}>Проверить остановку и восстановить</Button>}
    </div>
    {pending&&<p className="plugin-controls__line ui-text-muted" role="status">{pending==="prepare"?"Проверка пакета, backup и подготовка хранилища…":"Ожидаем подтверждение native-команды…"}</p>}
    {result&&<p className="plugin-controls__line ui-text-success" role="status">{result}</p>}{failure&&failure!==shown&&<p className="plugin-controls__line ui-text-danger" role="alert">{failure}</p>}
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
        frame.current?.contentWindow?.postMessage({type:"plugin-host-ready",version:UI_VERSION,instance,pluginId:plugin.id,pluginVersion:plugin.installed.active},"*");
        // Package screens (e.g. hero type-to-search) receive keys only inside the frame.
        if (!document.activeElement || document.activeElement === document.body) frame.current?.focus();
        return;
      }
      if (legacy && event.data?.type === "hello-ui-ready" && event.data.version === 1) { ready = true; window.clearTimeout(timeout); return; }
      const request = uiRequest(event,frame.current?.contentWindow ?? null,instance,commands);
      if (ready && request) {
        const reply = (result: unknown, error?: string) => { if (!disposed) frame.current?.contentWindow?.postMessage({type:"plugin-result",version:UI_VERSION,instance,requestId:request.requestId,ok:!error,result,error},"*"); };
        if (request.requestId <= lastRequest) { reply(null,"stale_ui_request"); return; }
        lastRequest = request.requestId;
        if (inFlight >= 8) { reply(null,"plugin_request_quota"); return; }
        inFlight++;
        try { reply(await api.request(plugin.id,request.name,request.args,plugin.installed.active)); }
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
  // The frame fills the rest of the window (CSS flex); the plugin document is
  // the only thing that scrolls, never the Companion page around it.
  return <div className="plugin-frame">{error && <Notice tone="danger">{error}</Notice>}
    <iframe ref={frame} title={plugin.manifest?.name ?? plugin.id} sandbox="allow-scripts" referrerPolicy="no-referrer"
      onLoad={() => frame.current?.contentWindow?.postMessage({type:"plugin-host-probe",version:UI_VERSION},"*")}
      src={pluginAsset(plugin.id, plugin.installed.active, relative)} />
  </div>;
}
