import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Button, Input } from "../components/ui";
import * as api from "../plugins/api";
import { greeting } from "../plugin-lab/bridge";

const phaseText = { running: "Работает", starting: "Запускается", stopped: "Остановлен", failed: "Ошибка процесса" };

export function PluginsPage() {
  const [view, setView] = useState<api.View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);
  const [local, setLocal] = useState("");
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    try { const result = await api.view(); if (mounted.current) setView(result); }
    catch (e) { if (mounted.current) setError(api.errorText(e)); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    let polling = false;
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
  const disabled = busy || view?.transfer.busy;
  const selected = view?.installed.find((p) => p.id === opened && p.installed.enabled && p.runtime?.phase === "running");
  return <section className="page-content" aria-label="Плагины">
    <h2>Плагины</h2>
    <p>Официальные плагины Companion. Dota 2 остаётся встроенной.</p>
    <Button disabled={disabled} onClick={() => void run(api.refresh)}>Обновить каталог</Button>
    {(error || view?.error) && <p role="alert">{error ?? api.errorText(view?.error)}</p>}
    {view?.catalogError && <p role="status">{api.errorText(view.catalogError)} Используется сохранённый каталог.</p>}
    {view?.transfer.busy && <div role="status">
      <p>{view.transfer.stage === "verify_install" ? "Проверка и установка" : "Загрузка"}: {Math.round(view.transfer.received / 1024)} КБ</p>
      <progress value={view.transfer.total ? view.transfer.received : undefined} max={view.transfer.total ?? 1} />
      <Button onClick={() => void api.cancel().catch((e) => setError(api.errorText(e)))}>Отменить загрузку</Button>
    </div>}
    {view?.transfer.error && !error && <p role="alert">{api.errorText(view.transfer.error)}</p>}
    <h3>Установленные</h3>
    {view && view.installed.length === 0 && <p>Плагины ещё не установлены.</p>}
    {view?.installed.map((p) => <article key={p.id} style={{ marginBlock: 16 }}>
      <h4>{p.manifest?.name ?? p.id} · {p.installed.active}</h4>
      <p>{p.manifest?.description}</p>
      <p>{p.installed.enabled ? phaseText[p.runtime?.phase ?? "stopped"] : "Отключён"}</p>
      {p.installed.pending && <p role="status">Обновление {p.installed.pending} будет активировано после остановки.</p>}
      {(p.error || p.runtime?.lastError) && <p role="alert">{api.errorText(p.error ?? p.runtime?.lastError)}</p>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button disabled={disabled} onClick={() => void run(async () => {
          if (!p.installed.enabled) await api.action(p.id, "enable");
          else if (p.runtime?.phase !== "running") await api.action(p.id, "start");
          if (mounted.current) setOpened(p.id);
        })}>Открыть</Button>
        <Button disabled={disabled} onClick={() => void run(() => api.action(p.id, p.installed.enabled ? "disable" : "enable"))}>{p.installed.enabled ? "Отключить" : "Включить"}</Button>
        <Button disabled={disabled || p.runtime?.phase !== "running"} onClick={() => void run(() => api.action(p.id, "stop"))}>Остановить</Button>
        {p.installed.previous && <Button disabled={disabled || p.runtime?.phase === "running"} onClick={() => void run(() => api.action(p.id, "rollback"))}>Откатить на {p.installed.previous}</Button>}
        <Button variant="danger" disabled={disabled} onClick={() => void run(() => api.action(p.id, "remove"))}>Удалить</Button>
      </div>
      <small>При удалении пользовательские данные сохраняются.</small>
    </article>)}
    <h3>Каталог</h3>
    {view && view.catalog.length === 0 && <p>В сохранённом каталоге нет пакетов для этой системы.</p>}
    {view?.catalog.map((r) => {
      const installed = view.installed.find((p) => p.id === r.manifest.id);
      const current = installed?.installed.active === r.manifest.version || installed?.installed.pending === r.manifest.version;
      const compatible = r.manifest.minApi <= 1 && r.manifest.maxApi >= 1;
      return <article key={`${r.manifest.id}-${r.manifest.version}`} style={{ marginBlock: 16 }}>
        <h4>{r.manifest.name} · {r.manifest.version}</h4>
        <p>{r.manifest.description}</p>
        <p>{!compatible ? "Несовместимая версия API" : current ? "Установлен" : "Доступен"}</p>
        <Button disabled={disabled || current || !compatible} onClick={() => void run(() => api.install(r.manifest.id, r.manifest.version))}>{installed ? "Обновить" : "Установить"}</Button>
        {view.localInstallAllowed && <Button disabled={disabled || current || !compatible || !local.trim()} onClick={() => void run(() => api.install(r.manifest.id, r.manifest.version, local.trim()))}>Установить локальный подписанный пакет</Button>}
      </article>;
    })}
    {view?.localInstallAllowed && <label>Путь к пакету для разработки (проверки подписи обязательны)<Input value={local} onChange={(e) => setLocal(e.target.value)} /></label>}
    {selected && <div>
      <Button onClick={() => setOpened(null)}>Закрыть UI</Button>
      <PluginUI key={`${selected.id}-${selected.installed.active}`} plugin={selected} />
    </div>}
  </section>;
}

function PluginUI({ plugin }: { plugin: api.Installed }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let ready = false; let disposed = false; let pending = false;
    const timeout = window.setTimeout(() => { if (!ready) setError("UI плагина не подтвердил загрузку. Проверьте WebView и CSP."); }, 8000);
    const handler = async (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === "hello-ui-ready" && event.data.version === 1) { ready = true; window.clearTimeout(timeout); return; }
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
    return () => { disposed = true; window.clearTimeout(timeout); window.removeEventListener("message", handler); };
  }, [plugin.id]);
  const relative = plugin.manifest?.ui.replace(/^ui\//, "") ?? "index.html";
  return <div>{error && <p role="alert">{error}</p>}
    <iframe ref={frame} title={plugin.manifest?.name ?? plugin.id} sandbox="allow-scripts" referrerPolicy="no-referrer"
      src={convertFileSrc(`${plugin.id}/${plugin.installed.active}/${relative}`, "plugin-ui")} style={{ width: "100%", height: 300 }} />
  </div>;
}
