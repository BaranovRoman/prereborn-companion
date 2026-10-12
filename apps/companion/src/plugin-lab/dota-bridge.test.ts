import { it, expect } from "vitest";
import { replayRequest } from "./dota-bridge";
it("permits only bounded replay messages from the sandbox frame", () => {
 const source={} as Window;
 const event=(data:unknown,origin=source)=>({source:origin,data}) as MessageEvent;
 const valid={type:"dota-replay-request",version:1,input:{sequence:1,snapshot:{}}};
 expect(replayRequest(event(valid),source)).toEqual(valid.input);
 expect(replayRequest(event(valid,{} as Window),source)).toBeNull();
 expect(replayRequest(event({...valid,version:2}),source)).toBeNull();
 expect(replayRequest(event({...valid,type:"obs.switch"}),source)).toBeNull();
 expect(replayRequest(event({...valid,input:{x:"я".repeat(60000)}}),source)).toBeNull();
});
