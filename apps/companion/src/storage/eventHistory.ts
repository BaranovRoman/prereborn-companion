import type { LastEvent } from "../types/status";

const STORAGE_KEY = "dota-companion:event-history";
const MAX_ENTRIES = 50;

/**
 * Keeps a small client-side ring buffer of recent GSI events in localStorage
 * so the "history" panel survives a window reload — the durable source of
 * truth is still the per-request JSON files Rust writes to disk.
 */
export function loadEventHistory(): LastEvent[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as LastEvent[]) : [];
  } catch {
    return [];
  }
}

export function appendEventHistory(event: LastEvent): LastEvent[] {
  const next = [event, ...loadEventHistory()].slice(0, MAX_ENTRIES);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function clearEventHistory(): void {
  localStorage.removeItem(STORAGE_KEY);
}
