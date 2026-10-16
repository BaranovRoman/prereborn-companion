import { useEffect, useState } from "react";
import { invoke, type Status } from "../api";

// The sandbox has no fetch permission. Query the actual owning worker, then
// require the real nested renderer's existing ready message; never fake a preview.
export function useLocalOverlayPreviewReady(scene?:string){
 const [ready,setReady]=useState(false);const [error,setError]=useState<string|null>(null);const [instance,setInstance]=useState(0);
 useEffect(()=>{
  let disposed=false,polling=false;let acknowledged=false;
  const poll=async()=>{if(polling)return;polling=true;try{
   const status=await invoke<Status>("status");if(disposed)return;
   const running=status.active&&status.overlay?.running===true;setReady(running);
   if(!running)setError(status.lastError??"Включите Dota-плагин для предпросмотра локального overlay.");
   else if(acknowledged)setError(null);
  }catch(e){if(!disposed){setReady(false);setError(String(e));}}finally{polling=false;}};
  const receive=(event:MessageEvent)=>{
   const frame=document.querySelector<HTMLIFrameElement>(".design-page__preview");
   if(event.source===frame?.contentWindow&&event.data?.type==="prereborn-overlay-preview-ready"){acknowledged=true;setError(null);}
  };
  window.addEventListener("message",receive);void poll();const timer=window.setInterval(()=>void poll(),1500);
  const timeout=window.setTimeout(()=>{if(!acknowledged&&!disposed)setError("Renderer не подтвердил загрузку. Проверьте включение плагина и native WebView; iframe не заменяется другим предпросмотром.");},6000);
  return()=>{disposed=true;window.removeEventListener("message",receive);window.clearInterval(timer);window.clearTimeout(timeout);};
 },[instance,scene]);
 return{ready,error,instance,retry:()=>{setReady(false);setError(null);setInstance(n=>n+1);}};
}
