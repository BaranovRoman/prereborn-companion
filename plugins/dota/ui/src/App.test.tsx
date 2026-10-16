// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Dota } from "./App";
const mocks=vi.hoisted(()=>({invoke:vi.fn(),catalog:vi.fn(),settings:vi.fn()}));
vi.mock("./api",()=>mocks);
// The editor has its own preserved control/parity tests.
vi.mock("./components/DesignPage",()=>({DesignPage:()=>null}));
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
  it("keeps overlay backend errors visible in diagnostics without presenting them as GSI failure",async()=>{
    const previous=mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async(name:string,args?:unknown)=>name==="status"?{prepared:true,active:true,awaitingSession:true,processed:2,lastError:null,overlayBackendError:"backend_response_limit"}:previous(name,args));
    render(<Dota/>);await screen.findByRole("button",{name:/Techies/});
    fireEvent.click(screen.getByRole("button",{name:"Настройки"}));
    expect(await screen.findByText(/Overlay backend: backend_response_limit/)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Ожидание игровой сессии");
  });
  it("waits for the worker receipt before reporting overlay visibility changed",async()=>{
    const previous=mocks.invoke.getMockImplementation()!;let resolve!:(v:unknown)=>void;let visible=true;
    mocks.invoke.mockImplementation(async(name:string,...args:unknown[])=>{
      if(name==="status")return {prepared:true,active:true,awaitingSession:true,overlayVisible:visible,showSummary:false};
      if(name==="overlay.hotkey")return {enabled:true,shortcut:"Ctrl+Alt+F11",registered:true,lastError:null};
      if(name==="overlay.visibility")return new Promise(r=>{resolve=v=>{visible=false;r(v);};});
      return previous(name,...args);
    });
    render(<Dota/>);await screen.findByRole("button",{name:/Techies/});fireEvent.click(screen.getByRole("button",{name:"Overlay"}));
    expect((screen.getByLabelText("Адрес overlay") as HTMLInputElement).value).toBe("http://127.0.0.1:3666/overlay");
    fireEvent.click(screen.getByRole("button",{name:"Скрыть overlay"}));
    await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith("overlay.visibility",{visible:false}));
    expect(screen.queryByText("Overlay скрыт.")).toBeNull();
    resolve({visible:false});await screen.findByText("Overlay скрыт.");expect(screen.getByRole("button",{name:"Показать overlay"})).toBeTruthy();
  });
  it("does not keep a healthy runtime header after status polling fails",async()=>{
    const previous=mocks.invoke.getMockImplementation()!;let calls=0;
    mocks.invoke.mockImplementation(async(name:string,...args:unknown[])=>{if(name==="status"&&++calls>1)throw Error("plugin_process_requires_recovery");return previous(name,...args);});
    render(<Dota/>);await screen.findByText(/Ожидание игровой сессии/);
    await screen.findByText("Состояние плагина не подтверждено",{}, {timeout:3000});
    expect(screen.queryByText(/Ожидание игровой сессии/)).toBeNull();
    expect((await screen.findByRole("alert")).textContent).toContain("plugin_process_requires_recovery");
  });
  it("keeps saved OBS mappings available offline and waits for the native save result",async()=>{
    const previous=mocks.invoke.getMockImplementation()!;const bindings={betweenMatches:"Saved idle",draft:"Saved draft",gameplay:"Saved game",postStream:"Saved summary"};
    const initial={configRevision:"a".repeat(64),bindings,enabled:false,connected:false,scenes:[]};let resolve!:(value:unknown)=>void;
    mocks.invoke.mockImplementation(async(name:string,...args:unknown[])=>name==="obs.settings"?initial:name==="obs.save"?new Promise(r=>{resolve=r;}):previous(name,...args));
    render(<Dota/>);await screen.findByRole("button",{name:/Techies/});fireEvent.click(screen.getByRole("button",{name:"OBS и сцены"}));
    await screen.findByText(/OBS недоступен/);expect((screen.getByLabelText("Игра") as HTMLInputElement).value).toBe("Saved game");
    fireEvent.change(screen.getByLabelText("Игра"),{target:{value:"New game"}});fireEvent.click(screen.getByRole("button",{name:"Сохранить сцены"}));
    await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith("obs.save",{expectedRevision:initial.configRevision,bindings:{...bindings,gameplay:"New game"}}));expect(screen.queryByText(/Сопоставление сохранено/)).toBeNull();
    resolve({...initial,configRevision:"b".repeat(64),bindings:{...bindings,gameplay:"New game"}});await screen.findByText(/Сопоставление сохранено/);
  });
  it("does not report success or retry after a stale OBS mapping precondition",async()=>{
    const previous=mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async(name:string,...args:unknown[])=>{if(name==="obs.settings")return {configRevision:"a".repeat(64),bindings:{betweenMatches:"Idle",draft:"Draft",gameplay:"Game",postStream:"Summary"},enabled:true,connected:true,scenes:["Idle","Draft","Game","Summary"]};if(name==="obs.save")throw Error("obs_configuration_changed");return previous(name,...args);});
    render(<Dota/>);await screen.findByRole("button",{name:/Techies/});fireEvent.click(screen.getByRole("button",{name:"OBS и сцены"}));await screen.findByRole("button",{name:"Сохранить сцены"});fireEvent.click(screen.getByRole("button",{name:"Сохранить сцены"}));
    await screen.findByText(/obs_configuration_changed/);expect(screen.queryByText(/Сопоставление сохранено/)).toBeNull();expect(mocks.invoke.mock.calls.filter(([name])=>name==="obs.save")).toHaveLength(1);
  });
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
