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
    <p>Официальные плагины Companion. По умолчанию Dota 2 работает встроенно.</p>
    <Button disabled={disabled} onClick={() => void run(api.refresh)}>Обновить каталог</Button>
    {(error || view?.error) && <p role="alert">{error ?? api.errorText(view?.error)}</p>}
    {view?.catalogError && <p role="status">{api.errorText(view.catalogError)} Используется сохранённый каталог.</p>}
    {view?.transfer.busy && <div role="status">
      {view.transfer.stage === "activation" ? <p>Выполняется ручная native-операция Dota…</p> : <>
      <p>{view.transfer.stage === "verify_install" ? "Проверка и установка" : "Загрузка"}: {Math.round(view.transfer.received / 1024)} КБ</p>
      <progress value={view.transfer.total ? view.transfer.received : undefined} max={view.transfer.total ?? 1} />
      <Button onClick={() => void api.cancel().catch((e) => setError(api.errorText(e)))}>Отменить загрузку</Button>
      </>}
    </div>}
    {view?.transfer.error && !error && <p role="alert">{api.errorText(view.transfer.error)}</p>}
    <h3>Установленные</h3>
    {view && view.installed.length === 0 && <p>Плагины ещё не установлены.</p>}
    {view?.installed.map((p) => <article key={p.id} style={{ marginBlock: 16 }}>
      <h4>{p.manifest?.name ?? p.id} · {p.installed.active}</h4>
      <p>{p.manifest?.description}</p>
      {p.id !== "dota2" && <p>{p.installed.enabled ? phaseText[p.runtime?.phase ?? "stopped"] : "Отключён"}</p>}
      {p.installed.pending && <p role="status">Обновление {p.installed.pending} будет активировано после остановки.</p>}
      {(p.error || p.runtime?.lastError) && <p role="alert">{api.errorText(p.error ?? p.runtime?.lastError)}</p>}
      {p.id === "dota2" ? <DotaControls disabled={!!disabled} run={run} /> : <>
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
      </>}
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

function DotaControls({ disabled, run }: { disabled: boolean; run: (task: () => Promise<void>) => Promise<void> }) {
  const [status, setStatus] = useState<api.DotaSafety | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [action, setAction] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
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
        setResult(nextAction === "prepare"
          ? `Подготовка подтверждена native: backup проверен, safety-таблицы готовы. BuiltIn · Epoch: ${next.runtime.epoch} · Unknown: ${next.quota!.unknown}. External не включён.`
          : `Native-команда завершена. Runtime: ${next.runtime.mode} · Epoch: ${next.runtime.epoch ?? "—"}.`);
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
    {result && <p role="status">{result}</p>}
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
