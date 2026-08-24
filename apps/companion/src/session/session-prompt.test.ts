import { describe, expect, it } from "vitest";
import {
  ACK_EXPIRY_MS,
  getSessionPromptMode,
  shouldShowSessionPrompt,
  STALE_THRESHOLD_MS,
  type SessionAck,
  type StreamSessionSummary,
} from "./session-prompt";

const NOW = Date.parse("2026-08-23T12:00:00.000Z");

function session(overrides: Partial<StreamSessionSummary> = {}): StreamSessionSummary {
  return {
    state: "active",
    id: "1",
    startedAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    endedAt: null,
    wins: 0,
    losses: 0,
    sessionRatingDelta: null,
    ...overrides,
  };
}

const hoursAgo = (hours: number) => new Date(NOW - hours * 60 * 60 * 1000).toISOString();
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60 * 1000).toISOString();

describe("shouldShowSessionPrompt", () => {
  it("does not show for a fresh session regardless of ack state", () => {
    const s = session({ updatedAt: minutesAgo(1) });
    expect(shouldShowSessionPrompt(s, null, NOW)).toBe(false);
  });

  it("shows for an old session with no ack", () => {
    const s = session({ updatedAt: hoursAgo(6) });
    expect(STALE_THRESHOLD_MS).toBeLessThan(6 * 60 * 60 * 1000);
    expect(shouldShowSessionPrompt(s, null, NOW)).toBe(true);
  });

  it("does not show when a matching ack was made 5 minutes ago (restart shortly after continue)", () => {
    const s = session({ id: "42", updatedAt: hoursAgo(6) });
    const ack: SessionAck = {
      sessionId: "42",
      sessionUpdatedAt: s.updatedAt,
      acknowledgedAt: minutesAgo(5),
    };
    expect(shouldShowSessionPrompt(s, ack, NOW)).toBe(false);
  });

  it("shows again when the ack belongs to a different session", () => {
    const s = session({ id: "42", updatedAt: hoursAgo(6) });
    const ack: SessionAck = {
      sessionId: "41",
      sessionUpdatedAt: s.updatedAt,
      acknowledgedAt: minutesAgo(5),
    };
    expect(shouldShowSessionPrompt(s, ack, NOW)).toBe(true);
  });

  it("shows again once the ack is older than ACK_EXPIRY_MS, even with no new activity", () => {
    const s = session({ id: "42", updatedAt: hoursAgo(6) });
    expect(ACK_EXPIRY_MS).toBeLessThan(13 * 60 * 60 * 1000);
    const ack: SessionAck = {
      sessionId: "42",
      sessionUpdatedAt: s.updatedAt,
      acknowledgedAt: hoursAgo(13),
    };
    expect(shouldShowSessionPrompt(s, ack, NOW)).toBe(true);
  });

  it("shows again when session.updatedAt moved on since the ack (new activity happened)", () => {
    const ack: SessionAck = {
      sessionId: "42",
      sessionUpdatedAt: hoursAgo(7),
      acknowledgedAt: minutesAgo(5),
    };
    const s = session({ id: "42", updatedAt: hoursAgo(6) });
    expect(shouldShowSessionPrompt(s, ack, NOW)).toBe(true);
  });

  it("shows for a session that never had any matches (updatedAt === startedAt, very old)", () => {
    const s = session({ startedAt: hoursAgo(30), updatedAt: hoursAgo(30) });
    expect(shouldShowSessionPrompt(s, null, NOW)).toBe(true);
  });
});

describe("getSessionPromptMode", () => {
  it("is hidden for a fresh active session", () => {
    const s = session({ updatedAt: minutesAgo(1) });
    expect(getSessionPromptMode(s, null, NOW)).toBe("hidden");
  });

  it("is continueOrNew for a stale active session with no ack", () => {
    const s = session({ updatedAt: hoursAgo(6) });
    expect(getSessionPromptMode(s, null, NOW)).toBe("continueOrNew");
  });

  it("is endedNewOnly for an explicitly ended session even when just closed (not stale)", () => {
    const s = session({ state: "ended", endedAt: minutesAgo(1), updatedAt: minutesAgo(1) });
    expect(getSessionPromptMode(s, null, NOW)).toBe("endedNewOnly");
  });

  it("is endedNewOnly for an ended session regardless of a valid ack", () => {
    const s = session({ id: "42", state: "ended", updatedAt: hoursAgo(6) });
    const ack: SessionAck = {
      sessionId: "42",
      sessionUpdatedAt: s.updatedAt,
      acknowledgedAt: minutesAgo(5),
    };
    expect(getSessionPromptMode(s, ack, NOW)).toBe("endedNewOnly");
  });
});
