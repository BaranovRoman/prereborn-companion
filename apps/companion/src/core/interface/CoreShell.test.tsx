// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../../App";
import { invoke } from "@tauri-apps/api/core";
import type { TwitchChatSession } from "../../chat/useTwitchChatSession";
import { DEFAULT_CHAT_SETTINGS } from "../../chat/chat-model";

const controls=vi.hoisted(()=>({check:vi.fn(),stop:vi.fn(),skip:vi.fn(),update:vi.fn(),playback:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn(),convertFileSrc:(s:string)=>s}));
vi.mock("@tauri-apps/api/event",()=>({listen:vi.fn().mockResolvedValue(()=>{})}));
vi.mock("../../chat/useTwitchChatSession",()=>({useTwitchChatSession:()=>chat}));
vi.mock("../audio/useManagedPluginAudio",()=>({useManagedPluginAudio:controls.playback}));
vi.mock("../../hooks/useUpdater",()=>({useUpdater:()=>({state:{phase:"idle"},checkForUpdate:controls.check,installUpdate:vi.fn(),restartToApply:vi.fn(),dismiss:vi.fn()})}));
vi.mock("../../hooks/useAutostart",()=>({useAutostart:()=>({state:{phase:"ready",enabled:false},busy:false,setAutostart:vi.fn()})}));
vi.mock("../../hooks/useAudioOutputDevice",()=>({useAudioOutputDevice:()=>({devices:[],selection:{mode:"system-default"},setSelection:vi.fn(),selectedDeviceMissing:false,selectedDeviceLabel:"",switchPrompt:null,onSwitchToNewDefault:vi.fn(),onKeepCurrentDevice:vi.fn()})}));
vi.mock("../../components/AccountForm",()=>({AccountForm:()=> <p>Аккаунт Companion</p>}));
vi.mock("../../components/IntegrationsPanel",()=>({IntegrationsPanel:()=> <p>Подключения аккаунта</p>}));
const host={companion_version:"test",backend_state:"waiting",obs_state:"waiting",obs_connected:false,obs_last_error:null,obs_streaming:null,obs_config:{enabled:false,host:"127.0.0.1",port:4455,password:"",gameplay_scene:"Existing scene"}};
let chat:TwitchChatSession;
beforeEach(()=>{
  vi.clearAllMocks();localStorage.clear();window.HTMLElement.prototype.scrollTo=vi.fn();
  chat={status:{accountConnected:true,configured:true,displayName:"Streamer",connected:true,state:"connected",messages:[]},error:null,unread:0,settings:{...DEFAULT_CHAT_SETTINGS},sileroStatus:null,sileroBusy:false,previewBusy:false,previewError:null,previewSileroVoice:vi.fn(),updateSetting:controls.update,stopTts:controls.stop,isSpeaking:()=>false,setViewerAtBottom:vi.fn(),markRead:vi.fn(),skipTts:controls.skip,lastSkipAt:null,skipHotkeyStatus:null,skipHotkeyBusy:false,updateSkipHotkey:vi.fn()};
  const config={...host.obs_config};
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if(command==="get_status")return {...host,obs_config:{...config,password:""}};
    if(command==="plugins_view")return {installed:[],catalog:[],error:null,catalogError:null,localInstallAllowed:false,transfer:{busy:false,id:null,received:0,total:null,stage:"",error:null}};
    if(command==="test_obs_connection")return ["Scene A"];
    if(command==="save_obs_config"){Object.assign(config,(args as {config:typeof config}).config);return {...host,obs_config:{...config,password:""}};}
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(cleanup);

it("uses six core sections, real service state and no game onboarding",async()=>{
  render(<App/>);await screen.findByText("Версия test");
  const nav=screen.getByRole("navigation",{name:"Разделы приложения"});
  expect(within(nav).getAllByRole("button").map((b)=>b.textContent?.replace(/^[^А-ЯA-Z]+/,""))).toEqual(["Обзор","Чат","Озвучка","OBS","Плагины","Настройки"]);
  expect(screen.getByText(/Подключён · Streamer/)).toBeTruthy();
  expect(screen.queryByText(/Найти Dota|Установить GSI|Активный матч|Герои/)).toBeNull();
  expect(controls.check).toHaveBeenCalledTimes(1);
  expect(vi.mocked(invoke).mock.calls.some(([name])=>String(name).includes("game_sound"))).toBe(false);
});
it("navigation keeps the one chat/TTS owner and exposes speech settings separately",async()=>{
  render(<App/>);await screen.findByText("Версия test");
  const nav=screen.getByRole("navigation");fireEvent.click(within(nav).getByRole("button",{name:"Чат"}));
  fireEvent.click(screen.getByRole("button",{name:"Настройки чата и TTS →"}));
  expect(await screen.findByRole("heading",{name:"Вывод звука"})).toBeTruthy();
  fireEvent.click(screen.getByLabelText("Озвучивать сообщения (TTS)"));
  expect(controls.update).toHaveBeenCalledWith("ttsEnabled",true);
  fireEvent.click(within(nav).getByRole("button",{name:"Обзор"}));
  expect(controls.stop).not.toHaveBeenCalled();expect(controls.skip).not.toHaveBeenCalled();expect(controls.check).toHaveBeenCalledTimes(1);
});
it("preserves opaque existing OBS configuration without resetting dirty input on polling",async()=>{
  render(<App/>);await screen.findByText("Версия test");
  fireEvent.click(within(screen.getByRole("navigation")).getByRole("button",{name:"OBS"}));
  fireEvent.change(screen.getByLabelText("Адрес"),{target:{value:"localhost"}});
  await new Promise((resolve)=>setTimeout(resolve,3100));
  expect((screen.getByLabelText("Адрес") as HTMLInputElement).value).toBe("localhost");
  fireEvent.click(screen.getByRole("button",{name:"Сохранить"}));
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith("save_obs_config",{config:expect.objectContaining({host:"localhost",gameplay_scene:"Existing scene",password:""})}));
  expect(await screen.findByText(/Настройки сохранены/)).toBeTruthy();
});
it("shows native read failures while keeping unrelated core navigation usable",async()=>{
  vi.mocked(invoke).mockRejectedValue("native_unavailable");
  render(<App/>);expect(await screen.findByRole("alert")).toBeTruthy();
  fireEvent.click(within(screen.getByRole("navigation")).getByRole("button",{name:"Настройки"}));
  expect(screen.getByText("Аккаунт Companion")).toBeTruthy();
  expect(controls.stop).not.toHaveBeenCalled();
});
