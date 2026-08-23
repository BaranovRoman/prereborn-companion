import type { SessionAck } from "./session-prompt";

const STORAGE_KEY = "companion-session-ack";

export function loadSessionAck(): SessionAck | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SessionAck) : null;
  } catch {
    return null;
  }
}

export function saveSessionAck(ack: SessionAck): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ack));
}

export function clearSessionAck(): void {
  localStorage.removeItem(STORAGE_KEY);
}
