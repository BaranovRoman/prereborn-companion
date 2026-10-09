// Core wire contracts. No Dota, match, overlay or legacy status imports.

export interface TwitchChatMessage {
  id: string;
  author: string;
  // Stable Twitch identity for this chatter, independent of the cosmetic
  // display name in `author` - see the matching comment in
  // apps/api's twitch-eventsub-chat.ts. Nullable: older cached
  // messages/backends may not carry these yet.
  authorId: string | null;
  authorLogin: string | null;
  color: string | null;
  text: string;
  badges: string[];
  messageType: string;
  receivedAt: string;
}
export type TwitchChatState = "connected" | "reconnecting" | "reauth_required" | "unavailable";
export interface TwitchChatStatus {
  accountConnected: boolean;
  configured: boolean;
  displayName: string | null;
  connected: boolean;
  state: TwitchChatState;
  messages: TwitchChatMessage[];
}
export type AccountMethod = "none" | "session" | "legacy_token";

export interface AccountStatus {
  connected: boolean;
  method: AccountMethod;
  email: string | null;
}

export interface TwitchIntegrationStatus {
  connected: boolean;
  login?: string;
  displayName?: string;
}

export type SileroTtsEngineState = "notStarted" | "starting" | "ready" | "crashed" | "unavailable";
export type SileroVoice = "aidar" | "baya" | "kseniya" | "xenia" | "eugene";
export interface SileroTtsStatus {
  enabled: boolean;
  state: SileroTtsEngineState;
  lastError: string | null;
  resourcesReady: boolean;
  voice: SileroVoice;
}

export interface SkipHotkeyStatus {
  enabled: boolean;
  shortcut: string;
  registered: boolean;
  lastError: string | null;
}

export interface TtsTraceEventInput {
  messageId: string;
  engine?: string;
  stages: Record<string, number>;
  detail?: unknown;
}
