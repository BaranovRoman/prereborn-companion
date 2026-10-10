import { analysis } from "./bridge";
const input = document.querySelector<HTMLTextAreaElement>("#input")!;
const output = document.querySelector<HTMLPreElement>("#result")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;
input.value = JSON.stringify({sequence:1,observedAtMs:100,snapshot:{player:{activity:"playing"},map:{game_state:"DOTA_GAMERULES_STATE_GAME_IN_PROGRESS"},hero:{id:105}}},null,2);
let pending = false;
document.querySelector("#replay")!.addEventListener("click", () => {
  if (pending) return;
  try {
    if (input.value.length > 60000) throw new Error("Replay frame too large");
    const data: unknown = JSON.parse(input.value);
    window.parent.postMessage({type:"dota-replay-request",version:1,input:data},"*"); pending = true;
    window.setTimeout(() => { if (pending) { pending=false; status.textContent="Replay-host не ответил. Это подготовленный UI, live API отсутствует."; } },2000);
  } catch (e) { status.textContent=String(e); }
});
window.addEventListener("message", (event) => {
  const result=analysis(event,window.parent); if (!result) return;
  pending=false; status.textContent="Изолированный replay; побочные эффекты отключены"; output.textContent=JSON.stringify(result,null,2);
});
window.parent.postMessage({type:"dota-ui-ready",version:1,mode:"replay_only"},"*");
