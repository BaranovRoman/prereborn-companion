import { analysis } from "./bridge";
const input = document.querySelector<HTMLTextAreaElement>("#input")!;
const output = document.querySelector<HTMLPreElement>("#result")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;
input.value = JSON.stringify({sequence:1,observedAtMs:100,snapshot:{player:{activity:"playing"},map:{game_state:"DOTA_GAMERULES_STATE_GAME_IN_PROGRESS"},hero:{id:105}}},null,2);
let pending = false;
let timeout: number | undefined;
document.querySelector("#replay")!.addEventListener("click", () => {
  if (pending) return;
  try {
    if (new TextEncoder().encode(input.value).length > 60000) throw new Error("Replay frame too large");
    const data: unknown = JSON.parse(input.value);
    window.parent.postMessage({type:"dota-replay-request",version:1,input:data},"*"); pending = true;
    timeout = window.setTimeout(() => { if (pending) { pending=false; status.textContent="Replay-host не ответил. Проверьте Start и статус процесса; live API отсутствует."; } },5000);
  } catch (e) { status.textContent=String(e); }
});
window.addEventListener("message", (event) => {
  if (event.source === window.parent && event.data?.type === "dota-replay-error" && event.data.version === 1) { window.clearTimeout(timeout); pending=false; status.textContent=String(event.data.error).slice(0,1024); return; }
  const result=analysis(event,window.parent); if (!result) return;
  window.clearTimeout(timeout); pending=false; status.textContent="Изолированный replay; побочные эффекты отключены"; output.textContent=JSON.stringify(result,null,2);
});
window.parent.postMessage({type:"dota-ui-ready",version:1,mode:"replay_only"},"*");
