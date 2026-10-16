// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PluginsPage } from "./PluginsPage";
import * as api from "../plugins/api";
vi.mock("../plugins/api", async (original) => ({ ...await original<typeof api>(), view: vi.fn(), refresh: vi.fn(), install: vi.fn(), cancel: vi.fn(), action: vi.fn(), command: vi.fn(), request: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => `plugin-ui://localhost/${p}` }));
const manifest = { id: "hello", name: "Hello World", description: "Test plugin", version: "0.1.0", platform: "macos", arch: "aarch64", minApi: 1, maxApi: 1, ui: "ui/index.html", permissions: ["ui"] };
const initial = (): api.View => ({ installed: [], catalog: [{ manifest, url: "https://github.com/test", sha256: "hash", signature: "sig" }], error: null, catalogError: null, localInstallAllowed: false, transfer: { busy: false, id: null, received: 0, total: null, stage: "", error: null } });
let view: api.View;
beforeEach(() => { view = initial(); vi.mocked(api.view).mockImplementation(async () => view); vi.mocked(api.action).mockResolvedValue(); vi.mocked(api.install).mockResolvedValue(); vi.mocked(api.cancel).mockResolvedValue(); vi.mocked(api.refresh).mockResolvedValue(); vi.mocked(api.command).mockResolvedValue({ text: "Hello" }); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe("PluginsPage", () => {
  it("opens API2 settings without activation or preparation and requires explicit confirmation", async () => {
    view.apiVersion=2;view.installed=[{id:"example",manifest:{...manifest,id:"example",name:"Installed Worker",minApi:2,maxApi:2,execution:"live",uiCommands:["status"]},installed:{active:"0.1.0",enabled:false,pending:null,previous:null},runtime:null,error:null}];
    render(<PluginsPage initialPluginId="example"/>);
    const prepare=await screen.findByRole("button",{name:"Подготовить backup и миграцию"});
    expect(prepare.hasAttribute("disabled")).toBe(true);
    expect(screen.getByTitle("Installed Worker").getAttribute("sandbox")).toBe("allow-scripts");
    expect(api.action).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox"));fireEvent.click(prepare);
    await waitFor(()=>expect(api.action).toHaveBeenCalledWith("example","prepare"));
    expect(await screen.findByText(/Подготовка подтверждена worker/)).toBeTruthy();
    expect(api.action).not.toHaveBeenCalledWith("example","enable");
  });
  it("keeps preparation errors visible across polling and never enables from unconfirmed state",async()=>{
    view.apiVersion=2;view.installed=[{id:"example",manifest:{...manifest,id:"example",minApi:2,maxApi:2,execution:"live"},installed:{active:"0.1.0",enabled:false,pending:null,previous:null},runtime:null,error:null}];
    vi.mocked(api.action).mockRejectedValueOnce(new Error("backup_verification_failed"));
    render(<PluginsPage initialPluginId="example"/>);
    fireEvent.click(await screen.findByRole("checkbox"));fireEvent.click(screen.getByRole("button",{name:"Подготовить backup и миграцию"}));
    await screen.findAllByText(/backup_verification_failed/);
    await new Promise(resolve=>setTimeout(resolve,750));
    expect(screen.getAllByText(/backup_verification_failed/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button",{name:"Включить"}).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText(/Подготовка подтверждена worker/)).toBeNull();
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
  it("binds API2 requests to their iframe nonce and rejects replayed or privileged calls", async () => {
    const current={...manifest,minApi:2,maxApi:2,uiCommands:["sound.settings"]};
    view.installed=[{id:"hello",manifest:current,error:null,installed:{active:"0.1.0",previous:null,pending:null,enabled:true},runtime:{phase:"running",lastError:null,state:null}}];
    vi.mocked(api.request).mockResolvedValue({enabled:false});
    render(<PluginsPage initialPluginId="hello"/>);
    const frame=await screen.findByTitle("Hello World") as HTMLIFrameElement;const source=frame.contentWindow!;
    const post=vi.spyOn(source,"postMessage");
    // Rendering the iframe does not prove that React's passive message listener
    // has been installed. Like the real UI's response to host probes, readiness
    // announcements are repeatable; wait for the actual host acknowledgement.
    await waitFor(()=>{
      fireEvent(window,new MessageEvent("message",{source,data:{type:"plugin-ui-ready",version:2}}));
      expect(post.mock.calls.some(([data])=>data.type==="plugin-host-ready")).toBe(true);
    });
    const hello=post.mock.calls.find(([data])=>data.type==="plugin-host-ready")![0];
    const request={type:"plugin-command",version:2,instance:hello.instance,requestId:1,name:"sound.settings",args:{}};
    fireEvent(window,new MessageEvent("message",{source,data:request}));
    await waitFor(()=>expect(api.request).toHaveBeenCalledExactlyOnceWith("hello","sound.settings",{}));
    fireEvent(window,new MessageEvent("message",{source,data:request}));
    fireEvent(window,new MessageEvent("message",{source:window,data:{...request,requestId:2}}));
    fireEvent(window,new MessageEvent("message",{source,data:{...request,requestId:2,name:"host.activate"}}));
    fireEvent(window,new MessageEvent("message",{source,data:{...request,requestId:2,instance:"old-scope"}}));
    expect(api.request).toHaveBeenCalledTimes(1);
    expect(post.mock.calls.some(([data])=>data.type==="plugin-result"&&data.error==="stale_ui_request")).toBe(true);
  });
});
