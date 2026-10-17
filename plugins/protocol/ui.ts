// The existing sandboxed postMessage bridge, versioned and bounded. No Tauri API.
export const UI_VERSION = 2;
export const MAX_UI_ARGS = 8192;
export interface UiRequest { type: "plugin-command"; version: 2; instance: string; requestId: number; name: string; args: unknown }
export function ready(event: MessageEvent, source: Window | null): boolean {
  return !!source && event.source === source && event.data?.type === "plugin-ui-ready" && event.data.version === UI_VERSION
    && Object.keys(event.data).length === 2;
}
export function request(event: MessageEvent, source: Window | null, instance: string, commands: readonly string[]): UiRequest | null {
  if (!source || event.source !== source) return null;
  const data = event.data;
  if (!data || data.type !== "plugin-command" || data.version !== UI_VERSION || data.instance !== instance ||
      !Number.isSafeInteger(data.requestId) || data.requestId <= 0 || typeof data.name !== "string" ||
      data.name.startsWith("host.") || !commands.includes(data.name) || Object.keys(data).some(k => !["type","version","instance","requestId","name","args"].includes(k))) return null;
  if (!Object.prototype.hasOwnProperty.call(data,"args")) return null;
  try { const encoded = JSON.stringify(data.args); if (encoded === undefined || new TextEncoder().encode(encoded).length > MAX_UI_ARGS) return null; }
  catch { return null; }
  return data as UiRequest;
}

export function client(parent: Window = window.parent) {
  let instance: string | null = null; let counter = 0;
  let connected!: () => void;
  let failed!: (error: Error) => void;
  const connection = new Promise<void>((resolve,reject) => { connected=resolve; failed=reject; });
  void connection.catch(() => {}); // Consumers still receive the rejected original promise.
  const connectionTimer = window.setTimeout(() => failed(new Error("plugin_host_not_ready")),8000);
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: number }>();
  const announce = () => parent.postMessage({type:"plugin-ui-ready",version:UI_VERSION},"*");
  const listener = (event: MessageEvent) => {
    if (event.source !== parent || event.data?.version !== UI_VERSION) return;
    const data = event.data;
    if (data.type === "plugin-host-probe") { announce(); return; }
    if (data.type === "plugin-host-ready" && typeof data.instance === "string" && data.instance.length >= 16 && data.instance.length <= 128) { instance = data.instance; window.clearTimeout(connectionTimer); connected(); return; }
    if (data.type !== "plugin-result" || data.instance !== instance) return;
    const entry = pending.get(data.requestId); if (!entry) return;
    pending.delete(data.requestId); window.clearTimeout(entry.timer);
    if (data.ok === true) entry.resolve(data.result); else entry.reject(new Error(String(data.error ?? "plugin_request_failed").slice(0,1024)));
  };
  window.addEventListener("message",listener); announce();
  return {
    connection,
    connected: () => instance !== null,
    invoke<T>(name: string, args: unknown = {}): Promise<T> {
      if (!instance) return Promise.reject(new Error("plugin_host_not_ready"));
      if (name.startsWith("host.")) return Promise.reject(new Error("ui_command_denied"));
      if (pending.size >= 8 || counter >= Number.MAX_SAFE_INTEGER) return Promise.reject(new Error("plugin_request_quota"));
      try { if (new TextEncoder().encode(JSON.stringify(args)).length > MAX_UI_ARGS) return Promise.reject(new Error("plugin_request_too_large")); }
      catch { return Promise.reject(new Error("invalid_plugin_request")); }
      const requestId = ++counter;
      return new Promise<T>((resolve,reject) => {
        const timer = window.setTimeout(() => { pending.delete(requestId); reject(new Error("plugin_request_timeout")); },["asset.import","image.import","directory.pick","link.open"].includes(name) ? 120000 : 5000);
        pending.set(requestId,{resolve: value => resolve(value as T),reject,timer});
        parent.postMessage({type:"plugin-command",version:UI_VERSION,instance,requestId,name,args},"*");
      });
    },
    dispose() { window.removeEventListener("message",listener); window.clearTimeout(connectionTimer); failed(new Error("plugin_ui_closed")); for (const entry of pending.values()) { window.clearTimeout(entry.timer); entry.reject(new Error("plugin_ui_closed")); } pending.clear(); instance = null; },
  };
}
