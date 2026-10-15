import { describe,it,expect } from "vitest";
import { ready,request,MAX_UI_ARGS } from "../../../../plugins/protocol/ui";
const source={} as Window;
function event(data: unknown,from:Window=source){return {source:from,data} as MessageEvent;}
const command={type:"plugin-command",version:2,instance:"nonce",requestId:1,name:"sound.settings",args:{}};
describe("sandboxed plugin UI bridge",()=>{
 it("requires the exact iframe window and a fresh parent scope",()=>{
  expect(ready(event({type:"plugin-ui-ready",version:2}),source)).toBe(true);
  expect(ready(event({type:"plugin-ui-ready",version:2,capabilities:["audio.play"]}),source)).toBe(false);
  expect(request(event(command),source,"nonce",[command.name])).toEqual(command);
  expect(request(event(command,{} as Window),source,"nonce",[command.name])).toBeNull();
  expect(request(event(command),source,"old-nonce",[command.name])).toBeNull();
 });
 it("cannot invoke host controls or undeclared commands even through a modified manifest list",()=>{
  expect(request(event({...command,name:"host.activate"}),source,"nonce",["host.activate"])).toBeNull();
  expect(request(event({...command,name:"sql"}),source,"nonce",[command.name])).toBeNull();
  expect(request(event({...command,tauri:"invoke"}),source,"nonce",[command.name])).toBeNull();
 });
 it("bounds UTF-8 data and requires safe correlated request IDs",()=>{
  for(const requestId of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,"1"]){expect(request(event({...command,requestId}),source,"nonce",[command.name])).toBeNull();}
  expect(request(event({...command,args:{text:"я".repeat(MAX_UI_ARGS)}}),source,"nonce",[command.name])).toBeNull();
  const cyclic:Record<string,unknown>={};cyclic.self=cyclic;
  expect(request(event({...command,args:cyclic}),source,"nonce",[command.name])).toBeNull();
 });
});
