// WK-53 - "active" means the backend has a live session for this account
// (see getOrCreateActiveSession); "ended" means the most recent session was
// explicitly closed via "Завершить стрим" (self-service, web dashboard) or
// by an admin, and no new one has been started yet.
export type SessionLifecycleState = "active" | "ended";

export interface StreamSessionSummary {
  state: SessionLifecycleState;
  id: string;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  wins: number;
  losses: number;
  sessionRatingDelta: number | null;
}

export interface SessionAck {
  sessionId: string;
  sessionUpdatedAt: string;
  acknowledgedAt: string;
}

// WK-83 - a stream break longer than this without any finalized match or
// manual W/L edit (both bump session.updatedAt on the backend) is treated
// as "probably a different stream, not a mid-stream restart".
export const STALE_THRESHOLD_MS = 4 * 60 * 60 * 1000;

// How long a "Продолжить" acknowledgement suppresses the prompt for the
// same session state before it's fair to ask again, even without new
// activity (e.g. the streamer acknowledged, then genuinely stopped for the
// rest of the day).
export const ACK_EXPIRY_MS = 12 * 60 * 60 * 1000;

export function isSessionStale(session: StreamSessionSummary, now: number): boolean {
  return now - Date.parse(session.updatedAt) > STALE_THRESHOLD_MS;
}

export function isAckValid(
  ack: SessionAck | null,
  session: StreamSessionSummary,
  now: number
): boolean {
  if (!ack) return false;
  if (ack.sessionId !== session.id) return false;
  if (ack.sessionUpdatedAt !== session.updatedAt) return false;
  return now - Date.parse(ack.acknowledgedAt) <= ACK_EXPIRY_MS;
}

export function shouldShowSessionPrompt(
  session: StreamSessionSummary,
  ack: SessionAck | null,
  now: number
): boolean {
  return isSessionStale(session, now) && !isAckValid(ack, session, now);
}

// WK-53 - "hidden": nothing to ask about. "continueOrNew": the WK-83 stale-
// session prompt (offers both "Продолжить" and "Начать новый стрим").
// "endedNewOnly": the previous stream was EXPLICITLY ended - "Продолжить"
// must not be offered at all here, regardless of how recently it happened
// (an ended session is never "continuable", unlike a merely stale one), only
// "Начать новый стрим".
export type SessionPromptMode = "hidden" | "continueOrNew" | "endedNewOnly";

export function getSessionPromptMode(
  session: StreamSessionSummary,
  ack: SessionAck | null,
  now: number
): SessionPromptMode {
  if (session.state === "ended") return "endedNewOnly";
  return shouldShowSessionPrompt(session, ack, now) ? "continueOrNew" : "hidden";
}
