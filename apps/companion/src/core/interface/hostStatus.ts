import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";

export interface ObsConnectionConfig {
  enabled: boolean; host: string; port: number; password: string;
  // Preserve existing opaque configuration fields while transport/UI are extracted.
  [key: string]: unknown;
}
export interface HostStatus {
  companion_version: string;
  backend_state: string;
  obs_state: string;
  obs_connected: boolean;
  obs_last_error: string | null;
  obs_streaming: boolean | null;
  obs_config: ObsConnectionConfig;
}
export const readHostStatus = () => invoke<HostStatus>("get_status");
export const saveObsConnection = (config: ObsConnectionConfig) => invoke<HostStatus>("save_obs_config", { config });
export const checkObsConnection = () => invoke<string[]>("test_obs_connection");

export function useHostStatus() {
  const [status,setStatus]=useState<HostStatus|null>(null);
  const [error,setError]=useState<string|null>(null);
  const mounted=useRef(false);
  const pending=useRef(false);
  const refresh=useCallback(async()=>{
    if(pending.current)return;
    pending.current=true;
    try{const next=await readHostStatus();if(mounted.current){setStatus(next);setError(null);}}
    catch(e){if(mounted.current)setError(String(e));}
    finally{pending.current=false;}
  },[]);
  useEffect(()=>{
    mounted.current=true;void refresh();
    const timer=window.setInterval(()=>void refresh(),3000);
    const listeners=["obs-status","backend-status"].map((event)=>listen(event,()=>void refresh()));
    return()=>{mounted.current=false;window.clearInterval(timer);listeners.forEach((p)=>void p.then((stop)=>stop()).catch(()=>{}));};
  },[refresh]);
  return {status,error,refresh};
}
