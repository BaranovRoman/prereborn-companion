import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

function script() {
  const base = resolve(process.cwd(), "src-tauri/src/core/plugin_ipc");
  return readFileSync(resolve(base, "ipc-protocol.js"), "utf8")
    .replace("__TEMPLATE_invoke_key__", '"test-invoke-key"')
    .replace("__RAW_process_ipc_message_fn__", readFileSync(resolve(base, "process-ipc-message-fn.js"), "utf8"))
    .replace("__TEMPLATE_os_name__", '"windows"')
    .replace("__TEMPLATE_fetch_channel_data_command__", '"plugin:__TAURI_CHANNEL__|fetch"');
}
describe("native IPC frame isolation", () => {
  it("does not install a native transport in an injected subframe", () => {
    const internals = {};
    const window = { self: {}, top: {}, __TAURI_INTERNALS__: internals };
    runInNewContext(script(), { window });
    expect(internals).not.toHaveProperty("postMessage");
  });
  it("preserves the main frame request format, key and callback", async () => {
    const runCallback = vi.fn();
    const internals: Record<string, any> = { convertFileSrc: (cmd: string) => `ipc://${cmd}`, runCallback };
    const window: Record<string, any> = { __TAURI_INTERNALS__: internals }; window.self = window; window.top = window;
    const fetch = vi.fn().mockResolvedValue({ headers: new Headers({ "Tauri-Response": "ok", "content-type": "application/json" }), json: async () => ({ ok: true }) });
    runInNewContext(script(), { window, fetch, Headers, console, setTimeout });
    internals.postMessage({ cmd: "get_status", callback: 1, error: 2, payload: { value: "привет" } });
    await vi.waitFor(() => expect(runCallback).toHaveBeenCalledWith(1, { ok: true }));
    const request = fetch.mock.calls[0][1];
    expect(request.headers.get("Tauri-Invoke-Key")).toBe("test-invoke-key");
    expect(JSON.parse(request.body)).toEqual({ value: "привет" });
  });
  it("preserves native postMessage fallback when custom protocol is blocked", async () => {
    const native = vi.fn();
    const internals: Record<string, any> = { convertFileSrc: () => "ipc://blocked" };
    const window: Record<string, any> = { __TAURI_INTERNALS__: internals, ipc: { postMessage: native } }; window.self = window; window.top = window;
    runInNewContext(script(), { window, fetch: () => Promise.reject(new Error("blocked")), Headers, console: { warn: vi.fn() }, setTimeout });
    internals.postMessage({ cmd: "get_status", callback: 1, error: 2, payload: { foo: "bar" } });
    await vi.waitFor(() => expect(native).toHaveBeenCalledOnce());
    expect(JSON.parse(native.mock.calls[0][0])).toMatchObject({ cmd: "get_status", payload: { foo: "bar" }, __TAURI_INVOKE_KEY__: "test-invoke-key" });
  });
});
