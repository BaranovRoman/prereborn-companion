// Visual-QA harness: the real Companion shell with mocked Tauri IPC, and the
// real Dota plugin UI served into the real sandboxed plugin iframe. See
// qa/README.md. Dev-only: not part of `vite build` (index.html is the sole input).
import { mockIPC } from "@tauri-apps/api/mocks";
import React from "react";
import ReactDOM from "react-dom/client";
import { companionCommand } from "./fixtures";

mockIPC((cmd, payload) => companionCommand(cmd, (payload ?? {}) as Record<string, unknown>), { shouldMockEvents: true });
// Plugin assets resolve to the harness proxy instead of the plugin-ui:// protocol.
(window as unknown as { __TAURI_INTERNALS__: { convertFileSrc: () => string } }).__TAURI_INTERNALS__.convertFileSrc = () => `${location.origin}/plugin-ui/`;

const { default: App } = await import("../src/App");
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<React.StrictMode><App /></React.StrictMode>);
