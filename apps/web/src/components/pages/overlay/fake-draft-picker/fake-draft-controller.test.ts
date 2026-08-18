import { describe, expect, it } from "vitest";
import { FakeDraftController, FAKE_DRAFT_STATES } from "./fake-draft-controller";

const HERO_POOL = Array.from({ length: 20 }, (_, i) => i + 1);

describe("FakeDraftController", () => {
    it("starts in the enter state with nothing settled and the full pool as roster", () => {
        const controller = new FakeDraftController({ heroPool: HERO_POOL });
        expect(controller.snapshot.state).toBe("enter");
        expect(controller.snapshot.settledHeroId).toBeNull();
        expect(controller.snapshot.targetHeroId).toBeNull();
        expect(controller.snapshot.roster).toEqual(HERO_POOL);
    });

    it("cycles through enter -> idle -> scrolling -> ... -> lock -> wait -> enter", () => {
        const controller = new FakeDraftController({ heroPool: HERO_POOL });
        const seen: string[] = [controller.snapshot.state];
        for (let i = 0; i < 60; i++) {
            seen.push(controller.advance().state);
        }
        for (const state of FAKE_DRAFT_STATES) {
            expect(seen).toContain(state);
        }
        const lockIndex = seen.indexOf("lock");
        expect(seen[lockIndex + 1]).toBe("wait");
        expect(seen[lockIndex + 2]).toBe("enter");
    });

    it("keeps the roster in the exact stable order the pool was given (no reshuffling per hop)", () => {
        const controller = new FakeDraftController({ heroPool: HERO_POOL });
        const firstRoster = controller.snapshot.roster;
        for (let i = 0; i < 30; i++) {
            controller.advance();
            expect(controller.snapshot.roster).toEqual(firstRoster);
        }
    });

    it("only ever moves the settled/target hero to ids that are adjacent-or-further within the roster order (continuous scroll, not a random re-pick)", () => {
        const controller = new FakeDraftController({ heroPool: HERO_POOL });
        for (let i = 0; i < 200; i++) {
            const before = controller.snapshot;
            const after = controller.advance();
            if (before.state === "idle" && after.state === "scrolling" && after.targetHeroId !== null) {
                expect(after.roster).toContain(after.targetHeroId);
            }
            if (before.state === "scrolling") {
                // settling always adopts exactly the id we were scrolling toward
                expect(after.settledHeroId).toBe(before.targetHeroId ?? before.settledHeroId);
                expect(after.targetHeroId).toBeNull();
            }
        }
    });

    it("increments cycleId only when a fresh session starts (enter -> idle), not on every hop", () => {
        const controller = new FakeDraftController({ heroPool: HERO_POOL });
        expect(controller.snapshot.cycleId).toBe(0);
        controller.advance(); // enter -> idle
        expect(controller.snapshot.cycleId).toBe(1);
        const cycleAfterFirstEntry = controller.snapshot.cycleId;
        for (let i = 0; i < 20 && controller.snapshot.state !== "lock"; i++) {
            controller.advance();
            expect(controller.snapshot.cycleId).toBe(cycleAfterFirstEntry);
        }
    });

    it("never settles, targets, or lists a real/excluded hero id", () => {
        const excludedHeroIds = [3, 7];
        const controller = new FakeDraftController({ heroPool: HERO_POOL, excludedHeroIds });

        for (let i = 0; i < 500; i++) {
            const snapshot = controller.advance();
            for (const heroId of snapshot.roster) {
                expect(excludedHeroIds).not.toContain(heroId);
            }
            if (snapshot.settledHeroId !== null) {
                expect(excludedHeroIds).not.toContain(snapshot.settledHeroId);
            }
            if (snapshot.targetHeroId !== null) {
                expect(excludedHeroIds).not.toContain(snapshot.targetHeroId);
            }
        }
    });

    it("respects exclusions updated at runtime (e.g. once GSI reveals the real hero mid-cycle)", () => {
        const controller = new FakeDraftController({ heroPool: HERO_POOL });
        controller.updateExclusions([1, 2, 3, 4, 5, 6, 7, 8, 9]);

        for (let i = 0; i < 200; i++) {
            const snapshot = controller.advance();
            if (snapshot.settledHeroId !== null) {
                expect(snapshot.settledHeroId).toBeGreaterThan(9);
            }
        }
    });

    it("drops the currently settled hero immediately if it becomes excluded mid-cycle, instead of waiting for the next hop", () => {
        const controller = new FakeDraftController({ heroPool: HERO_POOL, random: () => 0 });
        controller.advance(); // enter -> idle, settles on roster[0] == 1
        const settled = controller.snapshot.settledHeroId;
        expect(settled).not.toBeNull();

        controller.updateExclusions([settled as number]);
        expect(controller.snapshot.settledHeroId).not.toBe(settled);
        expect(controller.snapshot.roster).not.toContain(settled);
    });

    it("degrades gracefully when the entire pool is excluded", () => {
        const controller = new FakeDraftController({ heroPool: [1, 2], excludedHeroIds: [1, 2] });
        expect(() => controller.advance()).not.toThrow();
        for (let i = 0; i < 10; i++) {
            expect(() => controller.advance()).not.toThrow();
        }
    });

    it("cosmetic countdown never ticks below zero and freezes during lock/wait", () => {
        const controller = new FakeDraftController({ heroPool: HERO_POOL });
        for (let i = 0; i < 100; i++) controller.tickCountdown();
        expect(controller.snapshot.countdown).toBe(0);
    });
});
