// @vitest-environment jsdom
import {act,cleanup,render,waitFor} from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {listen} from "@tauri-apps/api/event";
import {invoke} from "@tauri-apps/api/core";
import {useManagedPluginAudio} from "./useManagedPluginAudio";
import type {PluginAudioPlayback} from "./playbackModel";
vi.mock("@tauri-apps/api/event",()=>({listen:vi.fn().mockResolvedValue(()=>{})}));
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn().mockResolvedValue(undefined)}));
vi.mock("../../audio/outputDevice",()=>({applySinkId:vi.fn().mockResolvedValue(undefined)}));
class Player{
 static instances:Player[]=[];volume=1;paused=false;onended:(()=>void)|null=null;onerror:(()=>void)|null=null;pause=vi.fn(()=>{this.paused=true;});
 constructor(public src:string){Player.instances.push(this);}play(){return Promise.resolve();}removeAttribute(){this.src="";}getAttribute(){return this.src||null;}load(){}
}
function Harness({synthesize,enabled=true}:{synthesize:(text:string)=>Promise<string>;enabled?:boolean}){useManagedPluginAudio({enabled:true,eventName:"plugin-play",fenceEvent:"plugin-fence",fenceAckCommand:"plugin_fence_ack",synthesize,voiceNotificationsEnabled:enabled},50);return null;}
function handler(name:string){const call=vi.mocked(listen).mock.calls.find(([event])=>event===name);if(!call)throw Error("listener missing");return call[1] as (event:{payload:unknown})=>void;}
function notification(id:string):PluginAudioPlayback{return{eventId:id,base64:"",mime:"audio/wav",speech:"bounded plugin notification",volume:80,correlationId:id,emittedAtMs:Date.now(),playback:{id,scope:{instance:`instance-${id}`,generation:1,epoch:1,session:null}}};}
beforeEach(()=>{vi.mocked(listen).mockClear();vi.mocked(invoke).mockClear();Player.instances=[];vi.stubGlobal("Audio",Player);vi.spyOn(URL,"createObjectURL").mockReturnValue("blob:plugin");vi.spyOn(URL,"revokeObjectURL").mockImplementation(()=>{});});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});
it("fences pending synthesis without constructing a late player or touching unrelated audio",async()=>{
 let resolve!:(base64:string)=>void;const synthesize=vi.fn(()=>new Promise<string>(r=>{resolve=r;}));render(<Harness synthesize={synthesize}/>);
 const unrelated=new Player("twitch-owned");const item=notification("pending");act(()=>handler("plugin-play")({payload:item}));expect(synthesize).toHaveBeenCalledWith(item.speech);
 act(()=>handler("plugin-fence")({payload:{instance:item.playback!.scope.instance,generation:1,requestId:"fence",playbackIds:[item.playback!.id]}}));
 await act(async()=>resolve("AAAA"));expect(Player.instances).toEqual([unrelated]);expect(unrelated.pause).not.toHaveBeenCalled();
 expect(invoke).toHaveBeenCalledWith("plugin_audio_ack",expect.objectContaining({status:"cancelled"}));expect(invoke).toHaveBeenCalledWith("plugin_fence_ack",expect.objectContaining({stopped:true}));
});
it("reports actual voice playback completion separately from queued synthesis",async()=>{
 render(<Harness synthesize={vi.fn().mockResolvedValue("AAAA")}/>);const item=notification("completed");act(()=>handler("plugin-play")({payload:item}));
 await waitFor(()=>expect(Player.instances).toHaveLength(1));expect(Player.instances[0].volume).toBeCloseTo(.4);
 expect(vi.mocked(invoke).mock.calls.some(([command,args])=>command==="plugin_audio_ack"&&(args as {status:string}).status==="completed")).toBe(false);
 act(()=>Player.instances[0].onended?.());expect(invoke).toHaveBeenCalledWith("plugin_audio_ack",{token:item.playback,status:"completed"});
});
it("cancels before synthesis when voice notifications are disabled",()=>{
 const synthesize=vi.fn();render(<Harness synthesize={synthesize} enabled={false}/>);act(()=>handler("plugin-play")({payload:notification("disabled")}));expect(synthesize).not.toHaveBeenCalled();expect(Player.instances).toHaveLength(0);
 expect(invoke).toHaveBeenCalledWith("plugin_audio_ack",expect.objectContaining({status:"cancelled"}));
});
