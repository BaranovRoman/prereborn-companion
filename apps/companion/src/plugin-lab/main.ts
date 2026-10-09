import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { greeting } from "./bridge";
const status = document.querySelector<HTMLParagraphElement>("#status")!;
const state = document.querySelector<HTMLPreElement>("#state")!;
const frame = document.querySelector<HTMLIFrameElement>("#plugin")!;
let ready = false;
let disposed = false;
async function report(result: string) { status.textContent = result; await invoke("plugin_lab_ui_result", { result }); }
async function start() {
  try { await invoke("plugin_lab_start"); status.textContent = "Runtime running"; }
  catch (error) { status.textContent = String(error); }
}
document.querySelector("#start")!.addEventListener("click", () => { void start(); });
document.querySelector("#stop")!.addEventListener("click", () => { void invoke("plugin_lab_stop"); });
document.querySelector("#crash")!.addEventListener("click", () => { void invoke("plugin_lab_command", { name: "crash", args: {} }).catch((e) => { status.textContent = String(e); }); });
window.addEventListener("message", async (event) => {
  if (event.source !== frame.contentWindow) return;
  if (event.data?.type === "hello-ui-ready" && event.data.version === 1 && !ready) {
    ready = true;
    try {
      const result = await invoke<{ text: string }>("plugin_lab_command", { name: "greet", args: { text: "iframe smoke" } });
      frame.contentWindow?.postMessage({ type: "hello-result", result }, "*");
      await report(`IFRAME_OK: ${result.text}`);
    } catch (error) { await report(`BRIDGE_FAILED: ${error}`); }
    return;
  }
  const text = greeting(event, frame.contentWindow);
  if (text === null) return;
  try {
    const result = await invoke("plugin_lab_command", { name: "greet", args: { text } });
    frame.contentWindow?.postMessage({ type: "hello-result", result }, "*");
  } catch (error) { frame.contentWindow?.postMessage({ type: "hello-result", error: String(error) }, "*"); }
});
const poll = window.setInterval(() => {
  if (!disposed) void invoke("plugin_lab_status").then((snapshot) => { state.textContent = JSON.stringify(snapshot, null, 2); }).catch((error) => { state.textContent = String(error); });
}, 500);
window.addEventListener("pagehide", () => { disposed = true; window.clearInterval(poll); });
await start();
// Platform-aware custom scheme URL; no file:// or localhost server fallback.
frame.src = convertFileSrc("index.html", "plugin-ui");
window.setTimeout(() => { if (!ready) void report("IFRAME_FAILED: no ready message after 8 seconds"); }, 8000);
