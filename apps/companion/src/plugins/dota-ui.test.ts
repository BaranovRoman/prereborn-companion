import { describe, expect, it } from "vitest";
import { analysis } from "../../../../plugins/dota/ui/bridge";
describe("Dota replay UI boundary", () => {
  it("accepts only versioned, effect-free replay snapshots from its parent", () => {
    const parent={} as Window;
    const event=(result:unknown,source=parent)=>({source,data:{type:"dota-replay-result",version:1,result}}) as MessageEvent;
    const valid={sequence:1,broadcastState:"gameplay",soundSignals:[],mode:"replay_only",sideEffects:false};
    expect(analysis(event(valid),parent)).toEqual(valid);
    expect(analysis(event(valid,{} as Window),parent)).toBeNull();
    expect(analysis(event({...valid,sideEffects:true}),parent)).toBeNull();
    expect(analysis(event({...valid,mode:"live"}),parent)).toBeNull();
    expect(analysis(event({...valid,broadcastState:"shell"}),parent)).toBeNull();
  });
});
