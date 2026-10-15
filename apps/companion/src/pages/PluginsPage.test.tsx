// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PluginsPage } from "./PluginsPage";
import * as api from "../plugins/api";
vi.mock("../plugins/api", async (original) => ({ ...await original<typeof api>(), view: vi.fn(), refresh: vi.fn(), install: vi.fn(), cancel: vi.fn(), action: vi.fn(), command: vi.fn(), dotaSafety: vi.fn(), dotaAction: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => `plugin-ui://localhost/${p}` }));
const manifest = { id: "hello", name: "Hello World", description: "Test plugin", version: "0.1.0", platform: "macos", arch: "aarch64", minApi: 1, maxApi: 1, ui: "ui/index.html", permissions: ["ui"] };
const initial = (): api.View => ({ installed: [], catalog: [{ manifest, url: "https://github.com/test", sha256: "hash", signature: "sig" }], error: null, catalogError: null, localInstallAllowed: false, transfer: { busy: false, id: null, received: 0, total: null, stage: "", error: null } });
let view: api.View;
beforeEach(() => { view = initial(); vi.mocked(api.view).mockImplementation(async () => view); vi.mocked(api.action).mockResolvedValue(); vi.mocked(api.install).mockResolvedValue(); vi.mocked(api.cancel).mockResolvedValue(); vi.mocked(api.refresh).mockResolvedValue(); vi.mocked(api.command).mockResolvedValue({ text: "Hello" }); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe("PluginsPage", () => {
  const safety = (): api.DotaSafety => ({ runtime: { mode: "built_in", epoch: 3, queued: 0, inFlight: 0, lost: 0, error: null, activationBlocker: null }, quota: { unknown: 0, remainingOperations: 100 }, storageError: null });
  const dota = () => {
    view.installed = [{ id: "dota2", manifest: { ...manifest, id: "dota2" }, error: null, installed: { active: "0.1.0", previous: null, pending: null, enabled: false }, runtime: null }];
    vi.mocked(api.dotaSafety).mockResolvedValue(safety());
  };
  it("shows cold waiting and demo restrictions from native state without starting or preparing", async () => {
    dota(); const next = safety(); next.runtime.mode = "external"; next.sessionBound = false; next.storageState = "ready";
    vi.mocked(api.dotaSafety).mockResolvedValue(next);
    render(<PluginsPage initialPluginId={view.installed.some((p) => p.id === "dota2") ? "dota2" : undefined} />);
    expect(await screen.findByText(/External: ожидание игровой сессии/)).toBeTruthy();
    expect(screen.getByText(/demo\/idle без сессии не выполняются/)).toBeTruthy();
    expect(api.dotaAction).not.toHaveBeenCalled();
  });
  it("keeps projection rejection visible after successful fallback and hides obsolete enable success", async () => {
    dota();vi.mocked(api.dotaAction).mockResolvedValue();
    render(<PluginsPage initialPluginId={view.installed.some((p) => p.id === "dota2") ? "dota2" : undefined} />);
    fireEvent.click(await screen.findByRole("checkbox"));
    const external=safety();external.runtime.mode="external";external.runtime.epoch=4;
    vi.mocked(api.dotaSafety).mockResolvedValue(external);
    fireEvent.click(screen.getByRole("button", {name:"Включить External Dota"}));
    expect(await screen.findByText(/Native-команда завершена. Runtime: external/)).toBeTruthy();
    const fallback=safety();fallback.runtime.epoch=5;fallback.runtime.projectionRejected=1;fallback.runtime.lastProjectionError="invalid_courier_item_slot";
    vi.mocked(api.dotaSafety).mockResolvedValue(fallback);
    expect(await screen.findByText(/Последнее отклонение GSI: invalid_courier_item_slot/)).toBeTruthy();
    expect(screen.queryByText(/Native-команда завершена. Runtime: external/)).toBeNull();
    expect(screen.getByText(/Runtime: built_in · Epoch: 5/)).toBeTruthy();
    await new Promise((resolve)=>setTimeout(resolve,750));
    expect(screen.getByText(/Последнее отклонение GSI: invalid_courier_item_slot/)).toBeTruthy();
    expect(api.dotaAction).toHaveBeenCalledTimes(1);
  });
  it("shows not_prepared without a storage failure and keeps activation blocked", async () => {
    dota(); const next = safety(); next.quota = null; next.storageState = "not_prepared";
    vi.mocked(api.dotaSafety).mockResolvedValue(next);
    render(<PluginsPage initialPluginId={view.installed.some((p) => p.id === "dota2") ? "dota2" : undefined} />);
    expect(await screen.findByText(/Safety-хранилище ещё не подготовлено/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Включить External Dota" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText(/Хранилище для External не подтверждено/)).toBeNull();
    expect(api.dotaAction).not.toHaveBeenCalled();
  });
  it("shows pending until native resolves, prevents repeated clicks and confirms actual post-state", async () => {
    dota();
    let complete!: () => void;
    vi.mocked(api.dotaAction).mockImplementation(() => new Promise<void>((resolve) => { complete = resolve; }));
    render(<PluginsPage initialPluginId={view.installed.some((p) => p.id === "dota2") ? "dota2" : undefined} />);
    fireEvent.click(await screen.findByRole("checkbox"));
    const button = screen.getByRole("button", { name: "Подготовить backup и миграцию" });
    fireEvent.click(button); fireEvent.click(button);
    expect(api.dotaAction).toHaveBeenCalledTimes(1);
    expect(api.dotaAction).toHaveBeenCalledWith("prepare", true);
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/Подготовка: ожидаем native/)).toBeTruthy();
    expect(screen.queryByText(/Подготовка подтверждена native/)).toBeNull();
    complete();
    expect(await screen.findByText(/Подготовка подтверждена native:.*Epoch: 3/)).toBeTruthy();
    expect(api.dotaSafety).toHaveBeenCalledTimes(2);
    expect(api.action).not.toHaveBeenCalled();
    // A subsequent explicit click is allowed, with another native ACK required.
    vi.mocked(api.dotaAction).mockResolvedValue();
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(api.dotaAction).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  });
  it("keeps the action error visible after successful status polling", async () => {
    dota();
    vi.mocked(api.dotaAction).mockRejectedValue("builtin_session_required");
    render(<PluginsPage initialPluginId={view.installed.some((p) => p.id === "dota2") ? "dota2" : undefined} />);
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Подготовить backup и миграцию" }));
    await screen.findByText(/Native-команда не подтвердила выполнение: Сначала начните/);
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(screen.getByText(/Native-команда не подтвердила выполнение/)).toBeTruthy();
    expect(screen.queryByText(/Подготовка подтверждена native/)).toBeNull();
  });
  it("does not claim success if the native post-state read fails", async () => {
    dota();
    vi.mocked(api.dotaAction).mockResolvedValue();
    vi.mocked(api.dotaSafety).mockResolvedValueOnce(safety()).mockRejectedValue("storage_unavailable");
    render(<PluginsPage initialPluginId={view.installed.some((p) => p.id === "dota2") ? "dota2" : undefined} />);
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Подготовить backup и миграцию" }));
    expect(await screen.findByText(/Native-команда завершена, но итоговое состояние не подтверждено/)).toBeTruthy();
    expect(screen.queryByText(/Подготовка подтверждена native/)).toBeNull();
    expect(screen.getByRole("button", { name: "Включить External Dota" }).hasAttribute("disabled")).toBe(true);
  });
  it("does not accept an ACK with Unknown post-state as preparation success", async () => {
    dota(); const next = safety(); next.quota!.unknown = 1;
    vi.mocked(api.dotaAction).mockResolvedValue();
    vi.mocked(api.dotaSafety).mockResolvedValueOnce(safety()).mockResolvedValue(next);
    render(<PluginsPage initialPluginId={view.installed.some((p) => p.id === "dota2") ? "dota2" : undefined} />);
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Подготовить backup и миграцию" }));
    await screen.findByText(/Native-команда завершена, но итоговое состояние не подтверждено/);
    expect(screen.queryByText(/Подготовка подтверждена native/)).toBeNull();
    expect(screen.getByRole("button", { name: "Включить External Dota" }).hasAttribute("disabled")).toBe(true);
  });
  it("labels native activation without offering download cancellation", async () => {
    view.transfer = { ...view.transfer, busy: true, stage: "activation" };
    render(<PluginsPage initialPluginId={view.installed.some((p) => p.id === "dota2") ? "dota2" : undefined} />);
    expect(await screen.findByText(/Выполняется ручная native-операция Dota/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Отменить загрузку" })).toBeNull();
  });
  it("shows native attempt failure after polling without sending another Prepare", async () => {
    dota(); const next = safety();
    next.preparation = { attempt: "attempt-1", stage: "manager_admitted", status: "failed", errorCode: "history_busy", startedAt: "2026-10-14T00:00:00Z", finishedAt: "2026-10-14T00:00:01Z" };
    vi.mocked(api.dotaSafety).mockResolvedValue(next);
    render(<PluginsPage initialPluginId={view.installed.some((p) => p.id === "dota2") ? "dota2" : undefined} />);
    expect(await screen.findByText(/Attempt: attempt-1.*Код: history_busy/)).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(screen.getByText(/Attempt: attempt-1.*Код: history_busy/)).toBeTruthy();
    expect(api.dotaAction).not.toHaveBeenCalled();
  });
  it("explains disabled Prepare while a native attempt remains pending", async () => {
    dota(); const next = safety();
    next.preparation = { attempt: "attempt-2", stage: "session_checked", status: "pending", errorCode: null, startedAt: "2026-10-14T00:00:00Z", finishedAt: null };
    vi.mocked(api.dotaSafety).mockResolvedValue(next);
    render(<PluginsPage initialPluginId={view.installed.some((p) => p.id === "dota2") ? "dota2" : undefined} />);
    fireEvent.click(await screen.findByRole("checkbox"));
    expect(screen.getByText(/Prepare заблокирован: Native Prepare ещё выполняется/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Подготовить backup и миграцию" }).hasAttribute("disabled")).toBe(true);
    expect(api.dotaAction).not.toHaveBeenCalled();
  });
  it.each(["unknown", "draining", "storage", "runtime"])("blocks External with %s and displays storage errors", async (issue) => {
    dota(); const next = safety();
    if (issue === "unknown") next.quota!.unknown = 1;
    if (issue === "draining") next.runtime.mode = "draining";
    if (issue === "storage") next.storageError = "backup_unavailable";
    if (issue === "runtime") next.runtime.error = "obs_fence_unconfirmed";
    vi.mocked(api.dotaSafety).mockResolvedValue(next);
    render(<PluginsPage initialPluginId={view.installed.some((p) => p.id === "dota2") ? "dota2" : undefined} />);
    fireEvent.click(await screen.findByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Включить External Dota" }).hasAttribute("disabled")).toBe(true);
    if (issue === "storage") expect(screen.getByText(/Хранилище для External не подтверждено/)).toBeTruthy();
    expect(api.dotaAction).not.toHaveBeenCalled();
  });
  it("requires explicit confirmation and prepared storage for External Dota", async () => {
    view.installed = [{ id: "dota2", manifest: { ...manifest, id: "dota2", name: "Dota 2" }, error: null, installed: { active: "0.1.0", previous: null, pending: null, enabled: false }, runtime: null }];
    vi.mocked(api.dotaSafety).mockResolvedValue({ runtime: { mode: "built_in", epoch: null, queued: 0, inFlight: 0, lost: 0, error: null, activationBlocker: null }, quota: null, storageError: "storage_unavailable" });
    vi.mocked(api.dotaAction).mockResolvedValue();
    render(<PluginsPage initialPluginId={view.installed.some((p) => p.id === "dota2") ? "dota2" : undefined} />);
    const prepare = await screen.findByRole("button", { name: "Подготовить backup и миграцию" });
    expect(prepare.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(prepare.hasAttribute("disabled")).toBe(false));
    expect(screen.getByRole("button", { name: "Включить External Dota" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(prepare);
    await waitFor(() => expect(api.dotaAction).toHaveBeenCalledWith("prepare", true));
    expect(api.action).not.toHaveBeenCalled();
  });
  it("does not offer activation when the platform fence is unavailable", async () => {
    view.installed = [{ id: "dota2", manifest: { ...manifest, id: "dota2" }, error: null, installed: { active: "0.1.0", previous: null, pending: null, enabled: false }, runtime: null }];
    vi.mocked(api.dotaSafety).mockResolvedValue({ runtime: { mode: "built_in", epoch: null, queued: 0, inFlight: 0, lost: 0, error: null, activationBlocker: "external_runtime_requires_windows_native_fences" }, quota: null, storageError: null });
    render(<PluginsPage initialPluginId={view.installed.some((p) => p.id === "dota2") ? "dota2" : undefined} />);
    fireEvent.click(await screen.findByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Подготовить backup и миграцию" }).hasAttribute("disabled")).toBe(true);
    expect(api.dotaAction).not.toHaveBeenCalled();
  });
  it("installs from the in-app catalog and hides local diagnostics in user mode", async () => {
    render(<PluginsPage initialPluginId={view.installed.some((p) => p.id === "dota2") ? "dota2" : undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Установить", exact: true }));
    await waitFor(() => expect(api.install).toHaveBeenCalledWith("hello", "0.1.0"));
    expect(screen.queryByText(/Путь к пакету/)).toBeNull();
  });
  it("keeps installed cards available offline and opening a disabled plugin never enables it", async () => {
    view.catalog=[]; view.catalogError="download_failed: 404";
    view.installed=[{ id:"hello", manifest, error:null, installed:{ active:"0.1.0", previous:null, pending:null, enabled:false }, runtime:null }];
    render(<PluginsPage />);
    expect(await screen.findByLabelText("Установленные плагины")).toBeTruthy();
    expect(screen.getByText("Hello World")).toBeTruthy();
    expect(screen.getByText(/Каталог сейчас недоступен/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", {name:"Открыть"}));
    expect(await screen.findByRole("button", {name:"Включить"})).toBeTruthy();
    expect(api.action).not.toHaveBeenCalled();
    expect(screen.queryByTitle("Hello World")).toBeNull();
    fireEvent.click(screen.getByRole("button", {name:"Все плагины"}));
    expect(screen.getByLabelText("Установленные плагины")).toBeTruthy();
  });
  it("cancels a transfer and displays offline catalog errors", async () => {
    view.transfer = { ...view.transfer, busy: true, received: 500, total: 1000 }; view.catalogError = "download_failed: 404";
    render(<PluginsPage initialPluginId={view.installed.some((p) => p.id === "dota2") ? "dota2" : undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Отменить загрузку" }));
    expect(api.cancel).toHaveBeenCalledOnce(); expect(screen.getByText(/Установленные плагины доступны независимо от каталога/)).toBeTruthy();
  });
  it("opens only a sandboxed UI and routes greetings only from that frame", async () => {
    view.installed = [{ id: "hello", manifest, error: null, installed: { active: "0.1.0", previous: null, pending: "0.2.0", enabled: true }, runtime: { phase: "running", lastError: null, state: null } }];
    render(<PluginsPage initialPluginId={view.installed.some((p) => p.id === "dota2") ? "dota2" : undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    const frame = await screen.findByTitle("Hello World") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.src).toContain("hello/0.1.0/index.html");
    expect(screen.getByText(/будет активировано после остановки/)).toBeTruthy();
    window.dispatchEvent(new MessageEvent("message", { data: { type: "hello-greet", text: "unsafe" }, source: window }));
    expect(api.command).not.toHaveBeenCalled();
    window.dispatchEvent(new MessageEvent("message", { data: { type: "hello-ui-ready", version: 1 }, source: frame.contentWindow }));
    window.dispatchEvent(new MessageEvent("message", { data: { type: "hello-greet", text: "UI" }, source: frame.contentWindow }));
    await waitFor(() => expect(api.command).toHaveBeenCalledWith("hello", "UI"));
  });
  it("offers disable and remove without deleting user data", async () => {
    view.installed = [{ id: "hello", manifest, error: null, installed: { active: "0.1.0", previous: "0.0.1", pending: null, enabled: true }, runtime: { phase: "stopped", lastError: null, state: null } }];
    render(<PluginsPage initialPluginId={view.installed.some((p) => p.id === "dota2") ? "dota2" : undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    fireEvent.click(await screen.findByRole("button", { name: "Отключить" }));
    await waitFor(() => expect(api.action).toHaveBeenCalledWith("hello", "disable"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Удалить" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
    await waitFor(() => expect(api.action).toHaveBeenCalledWith("hello", "remove"));
    expect(screen.getByText(/пользовательские данные сохраняются/)).toBeTruthy();
  });
});
