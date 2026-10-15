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
    const compatible = r.manifest.minApi <= (view?.apiVersion ?? 1) && r.manifest.maxApi >= 1;
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
      {view.transfer.stage === "activation" ? <p>Выполняется ручная native-операция Dota…</p> : <>
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
      <p>Версия {selected.installed.active} · {selected.id === "dota2" ? "Статус выполнения показан ниже" : selected.installed.enabled ? phaseText[selected.runtime?.phase ?? "stopped"] : "Отключён"}</p>
      <p>{selected.manifest?.author ? `Автор: ${selected.manifest.author}` : "Автор не указан в манифесте."}</p>
      {selected.installed.pending && <p role="status">Обновление {selected.installed.pending} будет активировано после остановки.</p>}
      {(selected.error || selected.runtime?.lastError) && <p role="alert">{api.errorText(selected.error ?? selected.runtime?.lastError)}</p>}
      {selected.id === "dota2" ? <DotaControls disabled={disabled} run={run} /> : <div className="plugin-actions">
        <Button disabled={disabled} onClick={() => void run(() => api.action(selected.id, selected.installed.enabled ? "disable" : "enable"))}>{selected.installed.enabled ? "Отключить" : "Включить"}</Button>
        {selected.installed.enabled && selected.runtime?.phase !== "running" && <Button disabled={disabled} onClick={() => void run(() => api.action(selected.id, "start"))}>Запустить</Button>}
        <Button disabled={disabled || selected.runtime?.phase !== "running"} onClick={() => void run(() => api.action(selected.id, "stop"))}>Остановить</Button>
        {selected.installed.previous && <Button disabled={disabled || selected.runtime?.phase === "running"} onClick={() => void run(() => api.action(selected.id, "rollback"))}>Откатить на {selected.installed.previous}</Button>}
        <Button variant="danger" disabled={disabled} onClick={() => void run(() => api.action(selected.id, "remove"))}>Удалить</Button>
      </div>}
      {view?.catalog.filter((r) => r.manifest.id === selected.id).map((r) => <div key={r.manifest.version}>{installButton(r)}</div>)}
      <small>При удалении пользовательские данные сохраняются.</small>
      {selected.installed.enabled && selected.runtime?.phase === "running" && <PluginUI key={`${selected.id}-${selected.installed.active}`} plugin={selected} />}
      {!selected.installed.enabled && <p>Чтобы открыть интерфейс плагина, включите его отдельным действием.</p>}
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

function DotaControls({ disabled, run }: { disabled: boolean; run: (task: () => Promise<void>) => Promise<void> }) {
  const [status, setStatus] = useState<api.DotaSafety | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [action, setAction] = useState<string | null>(null);
  const [result, setResult] = useState<{ text: string; mode: api.DotaSafety["runtime"]["mode"]; epoch: number | null } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const actionPending = useRef(false);
  const statusGeneration = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let disposed = false; let pending = false;
    const refresh = async () => {
      if (pending) return; pending = true;
      const generation = statusGeneration.current;
      try { const next = await api.dotaSafety(); if (!disposed && generation === statusGeneration.current) {
        // Pending polling may update diagnostics, never overwrite a newer action post-state.
        setStatus((previous) => actionPending.current && previous ? { ...previous, preparation: next.preparation } : next);
        setError(null);
      } }
      catch (e) { if (!disposed) setError(api.errorText(e)); }
      finally { pending = false; }
    };
    void refresh(); const timer = window.setInterval(() => void refresh(), 700);
    return () => { disposed = true; mounted.current = false; window.clearInterval(timer); };
  }, []);
  const execute = async (nextAction: Parameters<typeof api.dotaAction>[0]) => {
    // Synchronous guard also covers clicks before React applies disabled.
    if (actionPending.current) return;
    actionPending.current = true;
    statusGeneration.current += 1;
    setAction(nextAction); setResult(null); setActionError(null);
    await run(async () => {
      let acknowledged = false;
      try {
        await api.dotaAction(nextAction, nextAction === "disable" || confirmed);
        acknowledged = true;
        if (!mounted.current) return;
        statusGeneration.current += 1;
        const next = await api.dotaSafety();
        if (!mounted.current) return;
        setStatus(next); setError(null);
        if (nextAction === "prepare" && (next.runtime.mode !== "built_in" || next.runtime.epoch === null ||
          next.runtime.error || next.storageError || !next.quota || next.quota.unknown !== 0)) {
          throw new Error(next.runtime.error ?? next.storageError ?? "preparation_post_state_unconfirmed");
        }
        setResult({ mode: next.runtime.mode, epoch: next.runtime.epoch, text: nextAction === "prepare"
          ? `Подготовка подтверждена native: backup проверен, safety-таблицы готовы. BuiltIn · Epoch: ${next.runtime.epoch} · Unknown: ${next.quota!.unknown}. External не включён.`
          : `Native-команда завершена. Runtime: ${next.runtime.mode} · Epoch: ${next.runtime.epoch ?? "—"}.` });
      } catch (e) {
        if (mounted.current) setActionError(`${acknowledged ? "Native-команда завершена, но итоговое состояние не подтверждено" : "Native-команда не подтвердила выполнение"}: ${api.errorText(e)}`);
        throw e;
      } finally {
        actionPending.current = false;
        statusGeneration.current += 1;
        if (mounted.current) setAction(null);
      }
    });
  };
  const mode = status?.runtime.mode;
  const busy = disabled || action !== null;
  const nativePending = status?.preparation?.status === "pending";
  const blocked = busy || nativePending || !confirmed || !status || !!status.runtime.activationBlocker;
  const prepareReason = action ? "Ожидаем результат отправленной native-команды."
    : disabled ? "Другая операция Plugin Manager ещё выполняется."
    : nativePending ? "Native Prepare ещё выполняется."
    : !confirmed ? "Не отмечено ручное подтверждение."
    : !status ? "Ожидаем native safety status."
    : status.runtime.activationBlocker ? api.errorText(status.runtime.activationBlocker)
    : mode !== "built_in" ? `Подготовка недоступна в Runtime: ${mode}. Требуется безопасный возврат на BuiltIn.` : null;
  return <div aria-label="Dota runtime" aria-busy={action !== null}>
    <p>Runtime: {mode ?? "Проверка"} · Epoch: {status?.runtime.epoch ?? "—"}</p>
    {mode === "external" && status?.sessionBound === false && <p role="status">External: ожидание игровой сессии. Запустите Dota и настоящий матч. Звуки и игровые эффекты в demo/idle без сессии не выполняются.</p>}
    {status?.storageState === "not_prepared" && <p role="status">Safety-хранилище ещё не подготовлено. Выполните ручную подготовку; отсутствие safety-таблиц не является ошибкой истории.</p>}
    {status?.quota && <p>Осталось операций: {status.quota.remainingOperations}. Unknown: {status.quota.unknown}.</p>}
    {(error || status?.runtime.error || status?.runtime.activationBlocker) && <p role="alert">{error ?? api.errorText(status?.runtime.error ?? status?.runtime.activationBlocker)}</p>}
    {status?.storageError && <p role="status">Хранилище для External не подтверждено: {api.errorText(status.storageError)}</p>}
    {action && <p role="status">{action === "prepare" ? "Подготовка: ожидаем native preflight, backup и миграцию…" : "Ожидаем завершения native-команды…"}</p>}
    {status?.runtime.lastProjectionError && <p role="alert">Последнее отклонение GSI: {status.runtime.lastProjectionError}. Всего отклонено: {status.runtime.projectionRejected ?? 0}. Причина сохранена независимо от fallback; показан только код причины.</p>}
    {result && result.mode === mode && result.epoch === status?.runtime.epoch && <p role="status">{result.text}</p>}
    {actionError && <p role="alert">{actionError}</p>}
    {status?.preparation && <p role={status.preparation.status === "failed" ? "alert" : "status"}>
      Native Prepare · Attempt: {status.preparation.attempt} · Этап: {status.preparation.stage} · Статус: {status.preparation.status}
      {status.preparation.errorCode && <> · Код: {status.preparation.errorCode} — {api.errorText(status.preparation.errorCode)}</>}
    </p>}
    {status && !status.preparation && <p role="status">Native Prepare: в этом запуске attempt ещё не зарегистрирован.</p>}
    {prepareReason && <p role="status">Prepare заблокирован: {prepareReason}</p>}
    {!confirmed && <p>Чтобы отправить native-команду, отметьте ручное подтверждение ниже.</p>}
    <label><input type="checkbox" disabled={busy} checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
      Разрешаю ручную подготовку и переключение Dota. Подготовка создаст backup истории и добавит safety-таблицы. После новых записей старый backup восстанавливать нельзя.
    </label>
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <Button disabled={blocked || mode !== "built_in"} onClick={() => void execute("prepare")}>Подготовить backup и миграцию</Button>
      <Button disabled={blocked || !!actionError || mode !== "built_in" || !!status?.storageError || !!status?.runtime.error || !status?.quota || status.quota.unknown !== 0} onClick={() => void execute("enable")}>Включить External Dota</Button>
      <Button disabled={busy || !status || !["external", "fallback", "draining"].includes(mode ?? "")} onClick={() => void execute("disable")}>Отключить External → BuiltIn</Button>
      <Button disabled={busy || mode !== "draining" || !confirmed} onClick={() => void execute("recover")}>Подтвердить fences и вернуть BuiltIn</Button>
    </div>
    <small>Запуск только вручную. После перезапуска External не включается. При неподтверждённой остановке Dota остаётся Draining.</small>
  </div>;
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
