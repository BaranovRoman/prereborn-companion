import { useCallback, useEffect, useState } from "react";
import * as api from "../overlayApi";

export function useGameplayReferenceBackground(){
 const [imageUrl,setImageUrl]=useState<string|null>(null);const [opacity,setOpacity]=useState(.65);const [error,setError]=useState<string|null>(null);
 useEffect(()=>{let disposed=false;void api.getGameplayReference().then(url=>{if(!disposed)setImageUrl(url);}).catch(e=>{if(!disposed)setError(String(e));});return()=>{disposed=true;};},[]);
 const upload=useCallback(async()=>{setError(null);try{setImageUrl(await api.chooseGameplayReference());}catch(e){if(!String(e).includes("отменён"))setError(String(e));}},[]);
 const remove=useCallback(async()=>{setError(null);try{await api.removeGameplayReference();setImageUrl(null);}catch(e){setError(String(e));}},[]);
 return{imageUrl,opacity,error,upload,remove,setOpacity};
}
