import { analysis } from "../bridge";
const state=document.querySelector<HTMLOutputElement>("#state")!;
window.addEventListener("message", (event) => { const result=analysis(event,window.parent); if (result) state.textContent=`${result.broadcastState} · frame ${result.sequence}`; });
window.parent.postMessage({type:"dota-overlay-ready",version:1,mode:"replay_only"},"*");
