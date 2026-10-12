import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { replayRequest } from "./dota-bridge";
const frame = document.querySelector<HTMLIFrameElement>("#plugin")!;
const status = document.querySelector<HTMLElement>("#status")!;
const state = document.querySelector<HTMLElement>("#state")!;
let busy = false;
async function action(command: string, args?: unknown) {
  if (busy) throw new Error("replay_busy");
  busy = true;
  try {
    const result = await invoke(command, args as Record<string, unknown> | undefined);
    status.textContent = "OK";
    return result;
  } catch (error) { status.textContent = String(error); throw error; }
  finally { busy = false; }
}
for (const [id, command, args] of [["start", "plugin_lab_start", undefined], ["stop", "plugin_lab_stop", undefined], ["reset", "plugin_lab_command", {name:"dota.reset",args:{}}]] as const) {
  document.querySelector(`#${id}`)!.addEventListener("click", () => { void action(command,args).catch(() => {}); });
}
window.addEventListener("message", async event => {
  const input = replayRequest(event, frame.contentWindow); if (input === null) return;
  try {
    const result = await action("plugin_lab_command", {name:"dota.replay",args:input});
    frame.contentWindow?.postMessage({type:"dota-replay-result",version:1,result},"*");
  } catch (error) { frame.contentWindow?.postMessage({type:"dota-replay-error",version:1,error:String(error).slice(0,1024)},"*"); }
});
let polling = false;
const timer = window.setInterval(() => {
  if (polling || busy) return;
  polling = true;
  void invoke("plugin_lab_status").then(snapshot => { state.textContent=JSON.stringify(snapshot,null,2); })
    .catch(error => { status.textContent=String(error); }).finally(() => { polling=false; });
},500);
window.addEventListener("pagehide", () => { window.clearInterval(timer); });
// Release has no active LabConfig/commands/assets; even opening this static page cannot launch a child.
frame.src=convertFileSrc("index.html","plugin-ui");
