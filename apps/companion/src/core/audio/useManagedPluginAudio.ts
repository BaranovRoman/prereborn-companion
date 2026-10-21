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
  /** Both listeners are registered: native fences now get an answer. */
  onReady?: () => void;
}
export function useManagedPluginAudio({ enabled, eventName, fenceEvent, fenceAckCommand, onTiming,synthesize,voiceNotificationsEnabled=true,onReady }: Transport, overallVolume: number) {
  const readyRef = useRef(onReady); readyRef.current = onReady;
  // Speech synthesis may wait behind the core TTS engine. It must not hold
  // up media clips; both bounded lanes still share the same native fence.
  const lanes = useRef([createLane(2), createLane(1)]);
  const mounted = useRef(true);
  const enabledRef = useRef(enabled); enabledRef.current = enabled;
  const overallRef = useRef(overallVolume); overallRef.current = overallVolume;
  const timingRef = useRef(onTiming); timingRef.current = onTiming;
  const synthesisRef=useRef(synthesize);synthesisRef.current=synthesize;
  const notificationsRef=useRef(voiceNotificationsEnabled);notificationsRef.current=voiceNotificationsEnabled;
  const playNext = useCallback((lane: PlaybackLane) => {
    if (!mounted.current || lane.playing) return;
    let next: PluginAudioPlayback | null;
    do { next = lane.queue.takeNext(); }
    while (next && !pluginAudioFence.accepts(next.playback));
    if (!next) return;
    lane.playing = true;
    lane.token = next.playback?.id;
    playPayload(next, () => {
      lane.playing = false;
      lane.token = undefined;
      playNext(lane);
    }, lane.audio, overallRef.current, lane.cancel,
    (item,stage)=>timingRef.current?.(item,stage),notificationsRef.current?synthesisRef.current:undefined);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const unlistenPromise = listen<PluginAudioPlayback>(eventName, (event) => {
      const item: PluginAudioPlayback = event.payload;
      if (!mounted.current || !enabledRef.current || !pluginAudioFence.accepts(item.playback)) {
        pluginAudioFence.report(item.playback, "cancelled"); return;
      }
      const lane = lanes.current[item.speech !== undefined ? 1 : 0];
      if (!pluginAudioFence.track(item.playback, () => {
        if (lane.token === item.playback?.id) return lane.cancel.current?.() ?? false;
        return true; // queued command has been revoked before it can construct Audio
      })) { pluginAudioFence.report(item.playback, "unknown"); return; }
      timingRef.current?.(item, "frontend-received");
      if (!lane.queue.enqueue(item)) {
        pluginAudioFence.report(item.playback, "cancelled");
        return;
      }
      playNext(lane);
    });
    const fenceListener = listen<PluginAudioFence>(fenceEvent, ({ payload }) => {
      const stopped = pluginAudioFence.fence(payload);
      // Revocation precedes cancellation callbacks, so completion cannot start an old queued clip.
      void invoke(fenceAckCommand, { request: payload, stopped }).catch(() => {});
    });
    let alive = true;
    void Promise.all([unlistenPromise, fenceListener]).then(() => { if (alive) readyRef.current?.(); }, () => {});
    return () => {
      alive = false;
      mounted.current = false;
      for (const lane of lanes.current) {
        let queued: PluginAudioPlayback | null;
        while ((queued = lane.queue.takeNext())) pluginAudioFence.report(queued.playback, "cancelled");
        lane.cancel.current?.();
      }
      void unlistenPromise.then((unlisten) => unlisten());
      void fenceListener.then((unlisten) => unlisten());
    };
  }, [playNext,eventName,fenceEvent,fenceAckCommand]);

}

interface PlaybackLane {
  queue: BoundedPluginAudioQueue;
  playing: boolean;
  token?: string;
  audio: MutableRefObject<HTMLAudioElement | null>;
  cancel: MutableRefObject<(() => boolean) | null>;
}
function createLane(limit: number): PlaybackLane {
  return { queue: new BoundedPluginAudioQueue(limit), playing: false,
    audio: { current: null }, cancel: { current: null } };
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
