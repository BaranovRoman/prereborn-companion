import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../overlayApi";

// Editor-only opacity is package state behind the worker (the sandboxed frame
// has no storage); a slider drag writes once after it settles.
export function useGameplayReferenceBackground(){
 const [imageUrl,setImageUrl]=useState<string|null>(null);const [opacity,setOpacityState]=useState(.65);const [error,setError]=useState<string|null>(null);
 const timer=useRef<ReturnType<typeof setTimeout>>(undefined);
 useEffect(()=>{let disposed=false;void api.getGameplayReference().then(url=>{if(!disposed)setImageUrl(url);}).catch(e=>{if(!disposed)setError(String(e));});
  void api.getReferenceOpacity().then(value=>{if(!disposed)setOpacityState(value);}).catch(()=>undefined);
  return()=>{disposed=true;clearTimeout(timer.current);};},[]);
 const upload=useCallback(async()=>{setError(null);try{setImageUrl(await api.chooseGameplayReference());}catch(e){if(!String(e).includes("отменён"))setError(String(e));}},[]);
 const remove=useCallback(async()=>{setError(null);try{await api.removeGameplayReference();setImageUrl(null);}catch(e){setError(String(e));}},[]);
 const setOpacity=useCallback((value:number)=>{setOpacityState(value);clearTimeout(timer.current);timer.current=setTimeout(()=>{void api.saveReferenceOpacity(value).catch(e=>setError(String(e)));},300);},[]);
 return{imageUrl,opacity,error,upload,remove,setOpacity};
}
