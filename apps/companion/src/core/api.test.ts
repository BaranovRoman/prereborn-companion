import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import * as core from "./api";
import * as legacy from "../services/dotaCompanionApi";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("shared IPC compatibility", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  const trace = { messageId: "m1", stages: { queued: 123 } };
  const cases: [keyof typeof core, () => Promise<unknown>, string, unknown?][] = [
    ["getAccountStatus", core.getAccountStatus, "get_account_status"],
    ["accountLogin", () => core.accountLogin("a@b.test", "secret"), "account_login", { email: "a@b.test", password: "secret" }],
    ["accountLogout", core.accountLogout, "account_logout"],
    ["getTwitchChat", core.getTwitchChat, "get_twitch_chat"],
    ["getTwitchIntegrationStatus", core.getTwitchIntegrationStatus, "get_twitch_integration_status"],
    ["connectTwitch", core.connectTwitch, "connect_twitch"],
    ["disconnectTwitch", core.disconnectTwitch, "disconnect_twitch"],
    ["getSileroTtsStatus", core.getSileroTtsStatus, "get_silero_status"],
    ["setSileroTtsEnabled", () => core.setSileroTtsEnabled(true), "set_silero_enabled", { enabled: true }],
    ["setSileroVoice", () => core.setSileroVoice("xenia"), "set_silero_voice", { voice: "xenia" }],
    ["synthesizeSileroTts", () => core.synthesizeSileroTts("Полный текст", "xenia", "m1"), "synthesize_silero_tts", { text: "Полный текст", voice: "xenia", messageId: "m1" }],
    ["diagnosticsTraceTtsFrontend", () => core.diagnosticsTraceTtsFrontend(trace), "diagnostics_trace_tts_frontend", { event: trace }],
    ["getSkipHotkeyStatus", core.getSkipHotkeyStatus, "get_skip_hotkey_status"],
    ["setSkipHotkey", () => core.setSkipHotkey(false, "Alt+F10"), "set_skip_hotkey", { enabled: false, shortcut: "Alt+F10" }],
  ];

  it.each(cases)("%s preserves the existing command and result", async (name, call, command, args) => {
    const result = { sentinel: "unchanged" };
    vi.mocked(invoke).mockResolvedValueOnce(result);
    expect(legacy[name]).toBe(core[name]);
    expect(await call()).toBe(result);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(...(args === undefined ? [command] : [command, args]));
  });

  it("forwards errors without replacing them", async () => {
    const error = new Error("OBS/backend unavailable");
    vi.mocked(invoke).mockRejectedValueOnce(error);
    await expect(core.getTwitchChat()).rejects.toBe(error);
  });

  it("passes the full text and keeps an absent trace ID optional", async () => {
    const text = "Длинное сообщение. ".repeat(100);
    await core.synthesizeSileroTts(text, "aidar");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("synthesize_silero_tts", {
      text, voice: "aidar", messageId: undefined,
    });
  });
});
