// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
vi.mock("../services/dotaCompanionApi",()=>({getHeroLocalStats:vi.fn(),getHeroOpenDotaStats:vi.fn(),getHeroOpenDotaInsights:vi.fn(),getFavoriteHeroes:vi.fn(),saveFavoriteHeroes:vi.fn()}));
import * as service from "../services/dotaCompanionApi";
import {HeroStatistics} from "./HeroStatistics";
beforeEach(()=>{vi.mocked(service.getHeroLocalStats).mockResolvedValue({matches:4,wins:2,losses:1,avgKills:3,avgDeaths:null,avgAssists:4,recentResults:["win","loss"]});vi.mocked(service.getHeroOpenDotaStats).mockResolvedValue({status:"unavailable"});vi.mocked(service.getHeroOpenDotaInsights).mockResolvedValue({status:"unavailable"});vi.mocked(service.getFavoriteHeroes).mockResolvedValue([]);});
afterEach(()=>{cleanup();vi.resetAllMocks();});
it("retains real local statistics and nullable telemetry when external enrichment fails",async()=>{
 render(<HeroStatistics heroId={105}/>);expect(await screen.findByText("Локальная история Companion")).toBeTruthy();expect(screen.getByText("66.7%")).toBeTruthy();expect(screen.getByText("3.0 / — / 4.0")).toBeTruthy();expect(await screen.findByText("OpenDota сейчас недоступна.")).toBeTruthy();expect(service.getHeroLocalStats).toHaveBeenCalledWith(105);
});
it("changes the favorite only after its actual saved result and never retries an uncertain write",async()=>{
 let resolve!:(ids:number[])=>void;vi.mocked(service.saveFavoriteHeroes).mockImplementation(()=>new Promise(r=>{resolve=r;}));render(<HeroStatistics heroId={105}/>);
 const button=await screen.findByRole("button",{name:"Добавить в избранное"});await waitFor(()=>expect(button.hasAttribute("disabled")).toBe(false));fireEvent.click(button);
 expect(button.textContent).toBe("Добавить в избранное");expect(button.hasAttribute("disabled")).toBe(true);await act(async()=>resolve([105]));expect(screen.getByRole("button",{name:"Убрать из избранного"})).toBeTruthy();
 vi.mocked(service.saveFavoriteHeroes).mockRejectedValue(Error("backend_result_unknown"));fireEvent.click(screen.getByRole("button",{name:"Убрать из избранного"}));expect((await screen.findByRole("alert")).textContent).toContain("backend_result_unknown");expect(screen.getByRole("button",{name:"Убрать из избранного"})).toBeTruthy();expect(service.saveFavoriteHeroes).toHaveBeenCalledTimes(2);
});
it("does not invent zero matches when the actual history read fails",async()=>{
 vi.mocked(service.getHeroLocalStats).mockRejectedValue(Error("history_read_failed"));render(<HeroStatistics heroId={105}/>);expect((await screen.findByRole("alert")).textContent).toContain("history_read_failed");expect(screen.queryByText("Пока нет матчей в локальной истории")).toBeNull();
});
