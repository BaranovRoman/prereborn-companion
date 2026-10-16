// @vitest-environment jsdom
import { beforeEach,expect,it,vi } from "vitest";
const native=vi.hoisted(()=>({invoke:vi.fn()}));vi.mock("./api",()=>native);
import { chooseGameplayReference,getOverlayLayout,saveOverlayLayout,reconcileSettings } from "./overlayApi";
import type { OverlayLayoutDoc } from "./overlayTypes";
beforeEach(()=>{native.invoke.mockReset();});
it("returns the actual native saved document only after its receipt, with one operation key",async()=>{
 let finish!:(value:unknown)=>void;native.invoke.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const desired={version:5,scenes:{gameplay:{},draft:{}},future:{keep:true}} as unknown as OverlayLayoutDoc;
 const done=vi.fn();const save=saveOverlayLayout(desired).then(done);await Promise.resolve();expect(done).not.toHaveBeenCalled();
 expect(native.invoke.mock.calls[0][0]).toBe("backend.request");const request=native.invoke.mock.calls[0][1].request;
 expect(request.resource).toBe("overlay-layout-save");expect(request.operationKey).toMatch(/^setting:[0-9a-f-]{36}$/);expect(request.body).toEqual(desired);
 const normalized={...desired,normalized:true};finish({status:"completed",response:{status:200,error:null,body:normalized}});await save;expect(done).toHaveBeenCalledWith(normalized);expect(native.invoke).toHaveBeenCalledTimes(1);
});
it("does not retry an uncertain save and reconciles only through the native read path",async()=>{
 native.invoke.mockResolvedValue({status:"unknown",response:{status:null,body:null,error:"backend_result_unknown"}});
 await expect(saveOverlayLayout({version:5} as OverlayLayoutDoc)).rejects.toThrow("не подтверждён");expect(native.invoke).toHaveBeenCalledTimes(1);
 native.invoke.mockReset().mockRejectedValue(Error("backend_reconciliation_inconclusive"));
 await expect(reconcileSettings({operationKey:"setting:old",action:{kind:"backend_setting",request:{resource:"overlay-layout-save",operationKey:"setting:old",query:{},body:{version:5}}}})).rejects.toThrow("backend_reconciliation_inconclusive");
 expect(native.invoke).toHaveBeenCalledExactlyOnceWith("backend.reconcile",{readResource:"overlay-layout"});
});
it("does not turn a failed read into default or cached success",async()=>{
 native.invoke.mockResolvedValue({status:"completed",response:{status:503,body:null,error:"backend_http_rejected"}});
 await expect(getOverlayLayout()).rejects.toThrow("backend_http_rejected");expect(native.invoke).toHaveBeenCalledTimes(1);
});
it("image selection passes only managed metadata to the worker",async()=>{
 native.invoke.mockImplementation(async(name:string)=>name==="image.import"?{fileName:"managed.png"}:{url:"http://127.0.0.1:3666/overlay/assets/gameplay-reference?v=hash"});
 await expect(chooseGameplayReference()).resolves.toContain("/overlay/assets/gameplay-reference");
 expect(native.invoke.mock.calls).toEqual([["image.import"],["overlay.image.apply",{kind:"reference",fileName:"managed.png"}]]);
});
