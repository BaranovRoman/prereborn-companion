// @vitest-environment jsdom
import {beforeEach,expect,it,vi} from "vitest";
import {invoke} from "@tauri-apps/api/core";
import {Update} from "@tauri-apps/plugin-updater";
import {checkCompanionUpdate} from "./api";
vi.mock("@tauri-apps/api/core",async original=>({...await original<typeof import("@tauri-apps/api/core")>(),invoke:vi.fn()}));
beforeEach(()=>vi.mocked(invoke).mockReset());
it("uses the real stock Update resource returned by the fixed native updater check",async()=>{
 vi.mocked(invoke).mockResolvedValue({rid:41,currentVersion:"0.5.94",version:"0.5.95",date:"2026-10-16T00:00:00Z",body:"signed release",rawJson:{version:"0.5.95"}});
 const update=await checkCompanionUpdate();expect(invoke).toHaveBeenCalledWith("check_companion_update");expect(update).toBeInstanceOf(Update);expect(update?.rid).toBe(41);expect(update?.version).toBe("0.5.95");expect(typeof update?.downloadAndInstall).toBe("function");
});
it("does not construct or cache an updater resource after no-update or native failure",async()=>{
 vi.mocked(invoke).mockResolvedValueOnce(null);expect(await checkCompanionUpdate()).toBeNull();vi.mocked(invoke).mockRejectedValueOnce(new Error("native updater unavailable"));await expect(checkCompanionUpdate()).rejects.toThrow("native updater unavailable");
});
