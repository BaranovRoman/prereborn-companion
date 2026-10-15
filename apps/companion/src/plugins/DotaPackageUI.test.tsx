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
    if(name==="history.summary")return {hasSession:false,ratingCurrent:2400,wins:0,losses:0,currentMatch:null,recentMatches:[{localId:"preserved-uuid",matchId:"existing-game-id",heroId:105,state:"finished",result:"win",kills:3,deaths:2,assists:4,startedAt:"2026-10-15T00:00:00Z"}]};
    return {};
  });
});
afterEach(()=>{cleanup();vi.clearAllMocks();});
describe("installed Dota package UI",()=>{
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
});
