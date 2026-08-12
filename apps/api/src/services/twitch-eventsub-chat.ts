import WebSocket from "ws";
export interface TwitchChatMessage { id:string; author:string; color:string|null; text:string; badges:string[]; messageType:string; receivedAt:string }
type Envelope={metadata?:{message_id?:string;message_type?:string;message_timestamp?:string};payload?:{session?:{id?:string;keepalive_timeout_seconds?:number|null;reconnect_url?:string|null};subscription?:{type?:string};event?:{message_id?:string;chatter_user_name?:string;color?:string;message_type?:string;message?:{text?:string};badges?:Array<{set_id?:string;id?:string}>}}};
export interface EventSubSocket { on(event:"message",listener:(payload:unknown)=>void):void; on(event:"close"|"error",listener:()=>void):void; close():void }
interface Options { broadcasterId:string;clientId:string;getAccessToken:()=>Promise<string|null>;onMessage:(message:TwitchChatMessage)=>void;onConnected?:(value:boolean)=>void;createSocket?:(url:string)=>EventSubSocket;createSubscription?:(sessionId:string,token:string)=>Promise<void>;setTimer?:typeof setTimeout;clearTimer?:typeof clearTimeout }
const SOCKET_URL="wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30";
export const reconnectDelay=(attempt:number)=>Math.min(30_000,1_000*2**Math.min(attempt,5));
export const parseChatNotification=(value:Envelope,seen:Set<string>):TwitchChatMessage|null=>{
 if(value.metadata?.message_type!=="notification"||value.payload?.subscription?.type!=="channel.chat.message")return null;
 const eventId=value.metadata.message_id,event=value.payload.event;
 if(!eventId||!event?.message_id||!event.chatter_user_name||!event.message?.text||seen.has(eventId)||seen.has(event.message_id))return null;
 seen.add(eventId);seen.add(event.message_id);while(seen.size>160){const id=seen.values().next().value;if(id)seen.delete(id)}
 return{id:event.message_id,author:event.chatter_user_name,color:event.color||null,text:event.message.text,messageType:event.message_type||"text",badges:(event.badges??[]).map(b=>`${b.set_id??""}/${b.id??""}`),receivedAt:value.metadata.message_timestamp||new Date().toISOString()};
};
export class TwitchEventSubChatClient{
 private socket:EventSubSocket|null=null;private reconnectTimer:ReturnType<typeof setTimeout>|null=null;private watchdog:ReturnType<typeof setTimeout>|null=null;private stopped=true;private attempt=0;private generation=0;private readonly seen=new Set<string>();private readonly createSocket:(url:string)=>EventSubSocket;private readonly setTimer:typeof setTimeout;private readonly clearTimer:typeof clearTimeout;
 constructor(private readonly options:Options){this.createSocket=options.createSocket??(url=>new WebSocket(url)as EventSubSocket);this.setTimer=options.setTimer??setTimeout;this.clearTimer=options.clearTimer??clearTimeout}
 start(){if(this.stopped){this.stopped=false;void this.open(SOCKET_URL,false)}}
 stop(){this.stopped=true;this.generation++;this.options.onConnected?.(false);if(this.reconnectTimer)this.clearTimer(this.reconnectTimer);if(this.watchdog)this.clearTimer(this.watchdog);this.reconnectTimer=null;this.watchdog=null;const socket=this.socket;this.socket=null;socket?.close()}
 get connected(){return Boolean(this.socket)}
 private armWatchdog(seconds=30){if(this.watchdog)this.clearTimer(this.watchdog);this.watchdog=this.setTimer(()=>this.socket?.close(),(seconds+10)*1000)}
 private reconnect(generation:number){if(this.stopped||generation!==this.generation||this.reconnectTimer)return;this.options.onConnected?.(false);this.reconnectTimer=this.setTimer(()=>{this.reconnectTimer=null;if(!this.stopped&&generation===this.generation)void this.open(SOCKET_URL,false)},reconnectDelay(this.attempt++))}
 private async subscribe(sessionId:string){const token=await this.options.getAccessToken();if(!token)throw new Error("Twitch user token unavailable");if(this.options.createSubscription)return this.options.createSubscription(sessionId,token);const response=await fetch("https://api.twitch.tv/helix/eventsub/subscriptions",{method:"POST",headers:{Authorization:`Bearer ${token}`,"Client-Id":this.options.clientId,"Content-Type":"application/json"},body:JSON.stringify({type:"channel.chat.message",version:"1",condition:{broadcaster_user_id:this.options.broadcasterId,user_id:this.options.broadcasterId},transport:{method:"websocket",session_id:sessionId}})});if(!response.ok)throw new Error(`EventSub subscription returned ${response.status}`)}
 private async open(url:string,sessionReconnect:boolean){if(this.stopped)return;const generation=++this.generation,previous=this.socket,socket=this.createSocket(url);if(this.watchdog)this.clearTimer(this.watchdog);this.watchdog=this.setTimer(()=>socket.close(),15_000);
  socket.on("message",raw=>{let value:Envelope;try{value=JSON.parse(typeof raw==="string"?raw:Buffer.isBuffer(raw)?raw.toString():String(raw))}catch{return}this.armWatchdog(value.payload?.session?.keepalive_timeout_seconds??30);
   if(value.metadata?.message_type==="session_welcome"){const sessionId=value.payload?.session?.id;if(!sessionId)return socket.close();this.socket=socket;if(sessionReconnect){this.attempt=0;this.options.onConnected?.(true);previous?.close()}else void this.subscribe(sessionId).then(()=>{if(socket===this.socket){this.attempt=0;this.options.onConnected?.(true)}}).catch(()=>socket.close());return}
   if(value.metadata?.message_type==="session_reconnect"&&socket===this.socket){const next=value.payload?.session?.reconnect_url;if(next)void this.open(next,true);return}
   const message=parseChatNotification(value,this.seen);if(message)this.options.onMessage(message)});
  socket.on("close",()=>{if(generation!==this.generation)return;if(socket===this.socket)this.socket=null;this.reconnect(generation)});socket.on("error",()=>socket.close())}
}
