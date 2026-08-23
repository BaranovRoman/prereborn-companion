import { describe, expect, it } from "vitest";
import { isMatchFromCurrentSession } from "./is-match-from-current-session";

describe("isMatchFromCurrentSession", () => {
    it("is current when the match's session matches the active session", () => {
        expect(isMatchFromCurrentSession("session-1", "session-1")).toBe(true);
    });

    it("is previous when the match's session differs from the active session", () => {
        expect(isMatchFromCurrentSession("session-1", "session-2")).toBe(false);
    });

    it("treats a missing match session id as current (no error, no dimming)", () => {
        expect(isMatchFromCurrentSession(null, "session-2")).toBe(true);
        expect(isMatchFromCurrentSession(undefined, "session-2")).toBe(true);
    });

    it("treats a missing active session id as current (unknown boundary, nothing to dim)", () => {
        expect(isMatchFromCurrentSession("session-1", null)).toBe(true);
        expect(isMatchFromCurrentSession("session-1", undefined)).toBe(true);
    });

    it("start-new-stream scenario: matches from the closed session become previous once a new session is active", () => {
        const closedSessionId = "session-1";
        const newSessionId = "session-2";
        const preResetMatches = ["a", "b", "c"].map(() => closedSessionId);

        // Before reset, activeSessionId === closedSessionId - all current.
        expect(preResetMatches.every((sid) => isMatchFromCurrentSession(sid, closedSessionId))).toBe(true);

        // After "Начать новый стрим", the same matches are now previous.
        expect(preResetMatches.every((sid) => isMatchFromCurrentSession(sid, newSessionId))).toBe(false);
    });

    it("new match after reset is current while the old matches stay previous", () => {
        const newSessionId = "session-2";
        const oldMatchSessionIds = ["session-1", "session-1", "session-1"];
        const newMatchSessionId = "session-2";

        expect(isMatchFromCurrentSession(newMatchSessionId, newSessionId)).toBe(true);
        expect(oldMatchSessionIds.map((sid) => isMatchFromCurrentSession(sid, newSessionId))).toEqual([
            false,
            false,
            false,
        ]);
    });
});
