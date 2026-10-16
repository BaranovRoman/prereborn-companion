//! Shared WebView transport only: no game catalog, rules, settings, history or Twitch queue.
import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { applySinkId } from "../../audio/outputDevice";
import { pluginAudioFence, stopPluginAudio, type PluginAudioFence } from "./playbackRegistry";
import { BoundedPluginAudioQueue, base64ToObjectUrl, type PluginAudioPlayback } from "./playbackModel";

interface Transport {
  enabled: boolean;
  eventName: string;
  fenceEvent: string;
  fenceAckCommand: string;
  onTiming?: (item: PluginAudioPlayback, stage: string) => void;
  synthesize?: (text:string)=>Promise<string>;
  voiceNotificationsEnabled?:boolean;
}
export function useManagedPluginAudio({ enabled, eventName, fenceEvent, fenceAckCommand, onTiming,synthesize,voiceNotificationsEnabled=true }: Transport, overallVolume: number) {
  const queue = useRef(new BoundedPluginAudioQueue());
  const playing = useRef(false);
  const mounted = useRef(true);
  const currentAudio = useRef<HTMLAudioElement | null>(null);
  const currentToken = useRef<string | undefined>(undefined);
  const cancelCurrent = useRef<(() => boolean) | null>(null);
  const enabledRef = useRef(enabled); enabledRef.current = enabled;
  const overallRef = useRef(overallVolume); overallRef.current = overallVolume;
  const timingRef = useRef(onTiming); timingRef.current = onTiming;
  const synthesisRef=useRef(synthesize);synthesisRef.current=synthesize;
  const notificationsRef=useRef(voiceNotificationsEnabled);notificationsRef.current=voiceNotificationsEnabled;
  const playNext = useCallback(() => {
    if (!mounted.current || playing.current) return;
    const next = queue.current.takeNext();
    if (!next) return;
    if (!pluginAudioFence.accepts(next.playback)) { playNext(); return; }
    playing.current = true;
    currentToken.current = next.playback?.id;
    playPayload(next, () => {
      playing.current = false;
      playNext();
    }, currentAudio, overallRef.current, cancelCurrent, (item,stage)=>timingRef.current?.(item,stage),notificationsRef.current?synthesisRef.current:undefined);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const unlistenPromise = listen<PluginAudioPlayback>(eventName, (event) => {
      const item: PluginAudioPlayback = event.payload;
      if (!mounted.current || !enabledRef.current || !pluginAudioFence.accepts(item.playback)) {
        pluginAudioFence.report(item.playback, "cancelled"); return;
      }
      if (!pluginAudioFence.track(item.playback, () => {
        if (currentToken.current === item.playback?.id) return cancelCurrent.current?.() ?? false;
        return true; // queued command has been revoked before it can construct Audio
      })) { pluginAudioFence.report(item.playback, "unknown"); return; }
      timingRef.current?.(item, "frontend-received");
      if (playing.current) {
        // Bounded burst policy - a drop here is silent by design (задача:
        // "новое событие либо игнорируется, либо встаёт в bounded
        // очередь"), not surfaced as an error.
        if (!queue.current.enqueue(item)) pluginAudioFence.report(item.playback, "cancelled");
        return;
      }
      playing.current = true;
      currentToken.current = item.playback?.id;
      playPayload(item, () => {
        playing.current = false;
        playNext();
      }, currentAudio, overallRef.current, cancelCurrent, (item,stage)=>timingRef.current?.(item,stage),notificationsRef.current?synthesisRef.current:undefined);
    });
    const fenceListener = listen<PluginAudioFence>(fenceEvent, ({ payload }) => {
      const stopped = pluginAudioFence.fence(payload);
      // Revocation precedes cancellation callbacks, so completion cannot start an old queued clip.
      void invoke(fenceAckCommand, { request: payload, stopped }).catch(() => {});
    });
    return () => {
      mounted.current = false;
      let queued: PluginAudioPlayback | null;
      while ((queued = queue.current.takeNext())) pluginAudioFence.report(queued.playback, "cancelled");
      void unlistenPromise.then((unlisten) => unlisten());
      void fenceListener.then((unlisten) => unlisten());
      cancelCurrent.current?.();
    };
  }, [playNext,eventName,fenceEvent,fenceAckCommand]);

}

function playPayload(
  item: PluginAudioPlayback,
  done: () => void,
  currentAudio: MutableRefObject<HTMLAudioElement | null>,
  overallVolume: number,
  cancelCurrent: MutableRefObject<(() => boolean) | null>,
  logTiming: (item: PluginAudioPlayback, stage: string) => void,
  synthesize?: (text:string)=>Promise<string>,
) {
  if(item.speech!==undefined){
    let finished=false;
    const cancel=()=>{if(!finished){finished=true;cancelCurrent.current=null;pluginAudioFence.report(item.playback,"cancelled");done();}return true;};
    cancelCurrent.current=cancel;pluginAudioFence.setCancellation(item.playback,cancel);
    if(!synthesize||!item.speech||new TextEncoder().encode(item.speech).length>256||/[\x00-\x1f\x7f]/.test(item.speech)){cancel();return;}
    // The token remains fenced while synthesis is pending. Late synthesis must
    // never construct a player after cancellation, unload or generation change.
    void synthesize(item.speech).then(base64=>{
      if(finished)return;
      if(!pluginAudioFence.accepts(item.playback)){cancel();return;}
      finished=true;
      playPayload({...item,speech:undefined,base64,mime:"audio/wav"},done,currentAudio,overallVolume,cancelCurrent,logTiming);
    }).catch(()=>{cancel();});
    return;
  }
  let url: string;
  let audio: HTMLAudioElement;
  try {
    url = base64ToObjectUrl(item.base64, item.mime);
    try { audio = new Audio(url); } catch (cause) { URL.revokeObjectURL(url); throw cause; }
  } catch {
    pluginAudioFence.report(item.playback, "cancelled"); // no player was created
    done();
    return;
  }
  audio.volume = (item.volume / 100) * (overallVolume / 100);
  currentAudio.current = audio;
  let finished = false;
  const cleanup = (status: "completed" | "cancelled" | "unknown") => {
    if (finished) return;
    finished = true;
    pluginAudioFence.report(item.playback, status);
    cancelCurrent.current = null;
    URL.revokeObjectURL(url);
    if (currentAudio.current === audio) currentAudio.current = null;
    done();
  };
  cancelCurrent.current = () => {
    const stopped = stopPluginAudio(audio);
    if (stopped) cleanup("cancelled"); else pluginAudioFence.report(item.playback, "unknown");
    return stopped;
  };
  pluginAudioFence.setCancellation(item.playback, cancelCurrent.current);
  audio.onended = () => cleanup("completed");
  audio.onerror = () => { if (stopPluginAudio(audio)) cleanup("cancelled"); else pluginAudioFence.report(item.playback, "unknown"); };
  logTiming(item, "audio-play-requested");
  // Reliability follow-up - fire-and-forget: routing to the selected output
  // device must never delay when playback actually starts (mirrors this
  // function's own "playback error не ломает listener" no-blocking policy).
  void applySinkId(audio);
  audio.play()
    .then(() => { if (!finished) { logTiming(item, "audio-playing"); pluginAudioFence.report(item.playback, "playing"); } })
    .catch(() => { if (!finished) { if (stopPluginAudio(audio)) cleanup("cancelled"); else pluginAudioFence.report(item.playback, "unknown"); } });
}
