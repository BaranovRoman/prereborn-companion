// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Dota } from "../../../../plugins/dota/ui/src/App";
const mocks=vi.hoisted(()=>({invoke:vi.fn(),catalog:vi.fn(),settings:vi.fn()}));
vi.mock("../../../../plugins/dota/ui/src/api",()=>mocks);
const asset={id:"existing",fileName:"existing.wav",originalName:"my-jump.wav",sizeBytes:4};
const settings={schemaVersion:1,enabled:true,masterVolume:63,bindings:[{eventId:"techies_suicide",kind:"abilityCast",assetId:asset.id}],assets:[asset]};
beforeEach(()=>{
  mocks.catalog.mockResolvedValue({items:[],heroes:[{id:"npc_dota_hero_techies",displayName:"Techies",iconUrl:"https://cdn.cloudflare.steamstatic.com/icon.png",abilities:[{id:"techies_suicide",displayName:"Blast Off!",status:"supported",iconUrl:"https://cdn.cloudflare.steamstatic.com/ability.png"}]}]});
  mocks.settings.mockResolvedValue(settings);
  mocks.invoke.mockImplementation(async(name:string)=>{
    if(name==="status")return {prepared:true,active:true,awaitingSession:true,processed:2,gsi:{accepted:2},lastError:null};
    if(name==="asset.import")return asset;
    if(name==="history.sync")return {pendingCount:0,retryingCount:0,failedCount:0,unknownDeliveryCount:0};
    if(name==="history.summary")return {hasSession:false,ratingCurrent:2400,wins:0,losses:0,currentMatch:null,recentMatches:[{localId:"preserved-uuid",matchId:"existing-game-id",heroId:105,state:"finished",result:"win",kills:3,deaths:2,assists:4,startedAt:"2026-10-15T00:00:00Z"}]};
    return {};
  });
});
afterEach(()=>{cleanup();vi.clearAllMocks();});
describe("installed Dota package UI",()=>{
  it("does not hide an uncertain OBS effect behind the active worker state",async()=>{
    const previous=mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async(name:string,...args:unknown[])=>name==="status"?{prepared:true,active:true,awaitingSession:true,obsError:"obs_result_unknown_requires_authoritative_reconciliation",lastError:null}:previous(name,...args));
    render(<Dota/>);await screen.findByRole("button",{name:/Techies/});
    expect((await screen.findByRole("alert")).textContent).toContain("obs_result_unknown_requires_authoritative_reconciliation");
    expect(screen.getByText(/Ожидание игровой сессии/)).toBeTruthy();
  });
  it("shows persisted uncertain delivery without claiming that history was sent",async()=>{
    const previous=mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async(name:string,...args:unknown[])=>name==="history.sync"?{pendingCount:2,retryingCount:1,failedCount:0,unknownDeliveryCount:1}:previous(name,...args));
    render(<Dota/>);await screen.findByRole("button",{name:/Techies/});fireEvent.click(screen.getByRole("button",{name:"История"}));
    await screen.findByText(/Результат доставки не подтверждён: 1/);
    expect(screen.getByText(/Ожидают отправки: 2/)).toBeTruthy();
    expect(screen.queryByText("Изменение сохранено в истории.")).toBeNull();
  });
  it("writes MMR only with a fresh native context and displays success only after its exact receipt",async()=>{
    const previous=mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async(name:string,args?:unknown)=>{
      if(name==="history.context")return {active:true,revision:7,session:"preserved-session"};
      if(name==="history.edit"){const request=args as {operationKey:string;expectedRevision:number;session:string};return {operationKey:request.operationKey,beforeRevision:7,revision:8,resolvedSession:request.session,streamEnded:false};}
      return previous(name,args);
    });
    render(<Dota/>);await screen.findByRole("button",{name:/Techies/});fireEvent.click(screen.getByRole("button",{name:"История"}));await screen.findByText(/Текущий MMR: 2400/);
    fireEvent.change(screen.getByRole("spinbutton",{name:"Текущий MMR"}),{target:{value:"2500"}});fireEvent.click(screen.getByRole("button",{name:"Сохранить MMR"}));
    await screen.findByText("Изменение сохранено в истории.");
    expect(mocks.invoke).toHaveBeenCalledWith("history.edit",expect.objectContaining({operationKey:expect.stringMatching(/^manual:[0-9a-f-]{36}$/),expectedRevision:7,session:"preserved-session",edit:{kind:"rating",rating:2500}}));
  });
  it("does not optimistically apply or automatically retry a stale history write",async()=>{
    const previous=mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async(name:string,args?:unknown)=>{
      if(name==="history.context")return {active:true,revision:7,session:"preserved-session"};
      if(name==="history.edit")throw new Error("stale_revision");
      return previous(name,args);
    });
    render(<Dota/>);await screen.findByRole("button",{name:/Techies/});fireEvent.click(screen.getByRole("button",{name:"История"}));await screen.findByText(/Текущий MMR: 2400/);
    fireEvent.change(screen.getByRole("spinbutton",{name:"Текущий MMR"}),{target:{value:"2500"}});fireEvent.click(screen.getByRole("button",{name:"Сохранить MMR"}));
    await screen.findByRole("alert");expect(screen.getByRole("alert").textContent).toContain("stale_revision");
    expect(screen.queryByText("Изменение сохранено в истории.")).toBeNull();expect(screen.getByText(/Текущий MMR: 2400/)).toBeTruthy();
    expect(mocks.invoke.mock.calls.filter(([name])=>name==="history.edit")).toHaveLength(1);
  });
  it("shows the exact protected audio receipt without treating an emitted intent as completed playback",async()=>{
    const previous=mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async(name:string,...args:unknown[])=>{
      if(name==="status")return {prepared:true,active:true,awaitingSession:true,lastError:null,processed:2,detectedSounds:1,plannedSounds:1,lastSoundOperation:"sound:bound-generation:2:0",gsi:null};
      if(name==="audio.receipt")return {receipt:{operationKey:"core-qualified-key",status:"unknown"}};
      if(name==="gsi.find")return {found:false,installed:false};
      return previous(name,...args);
    });
    render(<Dota/>);await screen.findByRole("button",{name:/Techies/});fireEvent.click(screen.getByRole("button",{name:"Настройки"}));
    await screen.findByText(/Последний результат аудио ядра: unknown/);
    expect(mocks.invoke).toHaveBeenCalledWith("audio.receipt",{operationKey:"sound:bound-generation:2:0"});
    expect(screen.getByText(/обнаружено звуковых событий: 1/)).toBeTruthy();
    expect(screen.queryByText(/Последний результат аудио ядра: completed/)).toBeNull();
  });
  it("uses saved bindings and the protected host preview/import instead of iframe playback",async()=>{
    render(<Dota/>);fireEvent.click(await screen.findByRole("button",{name:/Techies/}));
    expect(screen.getByText("my-jump.wav")).toBeTruthy();
    fireEvent.click(screen.getByRole("button",{name:"Прослушать"}));
    await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith("asset.preview",{fileName:"existing.wav",volume:63}));
    fireEvent.click(screen.getByRole("button",{name:"Выбрать файл"}));
    await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith("sound.import",{eventId:"techies_suicide",kind:"abilityCast",asset}));
    expect(screen.getByText(/Ожидание игровой сессии/)).toBeTruthy();
    expect(mocks.invoke.mock.calls.some(([name])=>String(name).startsWith("host."))).toBe(false);
  });
  it("renders actual history and a failed worker status without reporting healthy activation",async()=>{
    mocks.invoke.mockImplementation(async(name:string)=>{
      if(name==="status")return {prepared:true,active:false,awaitingSession:false,lastError:"gsi_invalid_slot",processed:0,gsi:null};
      if(name==="history.summary")return {hasSession:false,ratingCurrent:2400,wins:0,losses:0,currentMatch:null,recentMatches:[]};
      return {};
    });
    render(<Dota/>);await screen.findByText("gsi_invalid_slot");
    expect(screen.getByText(/Плагин выключен/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button",{name:"История"}));
    await screen.findByText(/Текущий MMR: 2400/);
    expect(screen.queryByText("Плагин работает")).toBeNull();
    expect(screen.getByText("gsi_invalid_slot")).toBeTruthy();
  });
  it("does not register a binding after cancelled/failed native selection",async()=>{
    const invoke=mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((name:string,...args:unknown[])=>name==="asset.import"?Promise.reject(new Error("file_selection_cancelled")):invoke(name,...args));
    render(<Dota/>);fireEvent.click(await screen.findByRole("button",{name:/Techies/}));
    fireEvent.click(screen.getByRole("button",{name:"Выбрать файл"}));
    await screen.findAllByText(/file_selection_cancelled/);
    expect(mocks.invoke.mock.calls.some(([name])=>name==="sound.import")).toBe(false);
  });
  it("separates native directory selection, explicit GSI installation and runtime activation",async()=>{
    const previous=mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async(name:string,...args:unknown[])=>{
      if(name==="gsi.find")return {found:false,installed:false};
      if(name==="directory.pick")return {found:true,installed:false,path:"C:\\Steam\\dota 2 beta"};
      if(name==="gsi.install")return {found:true,installed:true,path:"C:\\Steam\\dota 2 beta"};
      return previous(name,...args);
    });
    render(<Dota/>);await screen.findByRole("button",{name:/Techies/});fireEvent.click(screen.getByRole("button",{name:"Настройки"}));
    await screen.findByText("Установка Dota не найдена автоматически.");
    expect(screen.getByRole("button",{name:"Настроить GSI"}).hasAttribute("disabled")).toBe(true);
    expect(mocks.invoke.mock.calls.some(([name])=>name==="gsi.install")).toBe(false);
    fireEvent.click(screen.getByRole("button",{name:"Выбрать папку Dota"}));
    await screen.findByText(/Dota найдена: C:/);
    await waitFor(()=>expect(screen.getByRole("button",{name:"Настроить GSI"}).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button",{name:"Настроить GSI"}));await screen.findByText(/Файл GSI найден/);
    expect(mocks.invoke.mock.calls.some(([name])=>String(name).startsWith("host."))).toBe(false);
    expect(mocks.invoke).toHaveBeenCalledWith("gsi.install");
  });
});
