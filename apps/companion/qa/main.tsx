// Visual-QA harness: the real Companion shell with mocked Tauri IPC, and the
// real Dota plugin UI served into the real sandboxed plugin iframe. See
// qa/README.md. Dev-only: not part of `vite build` (index.html is the sole input).
import { mockIPC } from "@tauri-apps/api/mocks";
import React from "react";
import ReactDOM from "react-dom/client";
import { companionCommand, scenario } from "./fixtures";

mockIPC((cmd, payload) => companionCommand(cmd, (payload ?? {}) as Record<string, unknown>), { shouldMockEvents: true });
// Plugin assets resolve to the harness proxy instead of the plugin-ui:// protocol.
(window as unknown as { __TAURI_INTERNALS__: { convertFileSrc: () => string } }).__TAURI_INTERNALS__.convertFileSrc = () => `${location.origin}/plugin-ui/`;

// A few dictionary rules for the "Озвучка" screen in the mid-session scenario.
const CHAT_SETTINGS_KEY = "companion-twitch-chat-settings-v1";
if (scenario === "default" && !localStorage.getItem(CHAT_SETTINGS_KEY)) {
  localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify({ ttsEnabled: true, pronunciationRules: [
    { id: "q1", source: "имба", spoken: "и+мба", enabled: true, scope: { kind: "global" } },
    { id: "q2", source: "бкб", spoken: "би кей би", enabled: true, scope: { kind: "global" } },
    { id: "q3", source: "кек", spoken: "кэк", enabled: false, scope: { kind: "global" } },
    { id: "q4", source: "лол", spoken: "лолик", enabled: true, scope: { kind: "user", login: "ромаромыч", userId: "u5" } },
  ] }));
}

const { default: App } = await import("../src/App");
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<React.StrictMode><App /></React.StrictMode>);
