export interface StreamSessionSummary {
  id: string;
  startedAt: string;
  updatedAt: string;
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
