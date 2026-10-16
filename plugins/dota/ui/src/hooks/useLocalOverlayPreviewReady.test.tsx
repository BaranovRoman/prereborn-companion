// @vitest-environment jsdom
import { act,cleanup,renderHook } from "@testing-library/react";
import { afterEach,beforeEach,expect,it,vi } from "vitest";
const native=vi.hoisted(()=>({invoke:vi.fn()}));vi.mock("../api",()=>native);
import { useLocalOverlayPreviewReady } from "./useLocalOverlayPreviewReady";
beforeEach(()=>{vi.useFakeTimers();native.invoke.mockReset();});
afterEach(()=>{cleanup();document.body.innerHTML="";vi.useRealTimers();});
it("requires this renderer's ready message and removes healthy state on native failure",async()=>{
 native.invoke.mockResolvedValue({active:true,overlay:{running:true}});
 const frame=document.createElement("iframe");frame.className="design-page__preview";document.body.appendChild(frame);
 const {result,rerender}=renderHook(({scene})=>useLocalOverlayPreviewReady(scene),{initialProps:{scene:"draft"}});
 await act(async()=>{});expect(result.current.ready).toBe(true);
 act(()=>window.dispatchEvent(new MessageEvent("message",{source:window,data:{type:"prereborn-overlay-preview-ready"}})));
 await act(async()=>{await vi.advanceTimersByTimeAsync(6001);});expect(result.current.error).toContain("не подтвердил загрузку");
 act(()=>window.dispatchEvent(new MessageEvent("message",{source:frame.contentWindow!,data:{type:"prereborn-overlay-preview-ready"}})));expect(result.current.error).toBeNull();
 rerender({scene:"gameplay"});await act(async()=>{});await act(async()=>{await vi.advanceTimersByTimeAsync(6001);});expect(result.current.error).toContain("не подтвердил загрузку");
 native.invoke.mockRejectedValue(Error("ipc_timeout"));await act(async()=>{await vi.advanceTimersByTimeAsync(1500);});expect(result.current.ready).toBe(false);expect(result.current.error).toContain("ipc_timeout");
});
it("does not fabricate a renderer while the installed worker is inactive",async()=>{
 native.invoke.mockResolvedValue({active:false,overlay:null});const {result}=renderHook(()=>useLocalOverlayPreviewReady("draft"));await act(async()=>{});
 expect(result.current.ready).toBe(false);expect(result.current.error).toContain("Включите Dota-плагин");expect(native.invoke).toHaveBeenCalledWith("status");
});
