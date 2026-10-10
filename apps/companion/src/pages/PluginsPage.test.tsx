// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PluginsPage } from "./PluginsPage";
import * as api from "../plugins/api";
vi.mock("../plugins/api", async (original) => ({ ...await original<typeof api>(), view: vi.fn(), refresh: vi.fn(), install: vi.fn(), cancel: vi.fn(), action: vi.fn(), command: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => `plugin-ui://localhost/${p}` }));
const manifest = { id: "hello", name: "Hello World", description: "Test plugin", version: "0.1.0", platform: "macos", arch: "aarch64", minApi: 1, maxApi: 1, ui: "ui/index.html", permissions: ["ui"] };
const initial = (): api.View => ({ installed: [], catalog: [{ manifest, url: "https://github.com/test", sha256: "hash", signature: "sig" }], error: null, catalogError: null, localInstallAllowed: false, transfer: { busy: false, id: null, received: 0, total: null, stage: "", error: null } });
let view: api.View;
beforeEach(() => { view = initial(); vi.mocked(api.view).mockImplementation(async () => view); vi.mocked(api.action).mockResolvedValue(); vi.mocked(api.install).mockResolvedValue(); vi.mocked(api.cancel).mockResolvedValue(); vi.mocked(api.refresh).mockResolvedValue(); vi.mocked(api.command).mockResolvedValue({ text: "Hello" }); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe("PluginsPage", () => {
  it("installs from the in-app catalog and hides local diagnostics in user mode", async () => {
    render(<PluginsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Установить", exact: true }));
    await waitFor(() => expect(api.install).toHaveBeenCalledWith("hello", "0.1.0"));
    expect(screen.queryByText(/Путь к пакету/)).toBeNull();
  });
  it("cancels a transfer and displays offline catalog errors", async () => {
    view.transfer = { ...view.transfer, busy: true, received: 500, total: 1000 }; view.catalogError = "download_failed: 404";
    render(<PluginsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Отменить загрузку" }));
    expect(api.cancel).toHaveBeenCalledOnce(); expect(screen.getByText(/Установленные плагины продолжают работать/)).toBeTruthy();
  });
  it("opens only a sandboxed UI and routes greetings only from that frame", async () => {
    view.installed = [{ id: "hello", manifest, error: null, installed: { active: "0.1.0", previous: null, pending: "0.2.0", enabled: true }, runtime: { phase: "running", lastError: null, state: null } }];
    render(<PluginsPage />);
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
    render(<PluginsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Отключить" }));
    await waitFor(() => expect(api.action).toHaveBeenCalledWith("hello", "disable"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Удалить" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
    await waitFor(() => expect(api.action).toHaveBeenCalledWith("hello", "remove"));
    expect(screen.getByText(/пользовательские данные сохраняются/)).toBeTruthy();
  });
});
