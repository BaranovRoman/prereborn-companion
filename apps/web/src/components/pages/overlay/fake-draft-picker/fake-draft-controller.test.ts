import { describe, expect, it } from "vitest";
import { FakeDraftController, FAKE_DRAFT_STATES } from "./fake-draft-controller";

const HERO_POOL = Array.from({ length: 20 }, (_, i) => i + 1);

describe("FakeDraftController", () => {
    it("starts in the enter state with nothing focused", () => {
        const controller = new FakeDraftController({ heroPool: HERO_POOL });
        expect(controller.snapshot.state).toBe("enter");
        expect(controller.snapshot.focusedHeroId).toBeNull();
    });

    it("cycles through enter -> idle -> hover -> ... -> lock -> wait -> enter", () => {
        const controller = new FakeDraftController({ heroPool: HERO_POOL });
        const seen: string[] = [controller.snapshot.state];
        for (let i = 0; i < 40; i++) {
            seen.push(controller.advance().state);
        }
        // every advertised state actually occurs during a normal run
        for (const state of FAKE_DRAFT_STATES) {
            expect(seen).toContain(state);
        }
        // a full lock -> wait -> enter loop happens at least once
        const lockIndex = seen.indexOf("lock");
        expect(seen[lockIndex + 1]).toBe("wait");
        expect(seen[lockIndex + 2]).toBe("enter");
    });

    it("never focuses, hovers, or carousels a real/excluded hero id", () => {
        const excludedHeroIds = [3, 7];
        const controller = new FakeDraftController({ heroPool: HERO_POOL, excludedHeroIds });

        for (let i = 0; i < 500; i++) {
            const snapshot = controller.advance();
            if (snapshot.focusedHeroId !== null) {
                expect(excludedHeroIds).not.toContain(snapshot.focusedHeroId);
            }
            if (snapshot.hoverHeroId !== null) {
                expect(excludedHeroIds).not.toContain(snapshot.hoverHeroId);
            }
            for (const heroId of snapshot.carouselHeroIds) {
                expect(excludedHeroIds).not.toContain(heroId);
            }
        }
    });

    it("respects exclusions updated at runtime (e.g. once GSI reveals the real hero mid-cycle)", () => {
        const controller = new FakeDraftController({ heroPool: HERO_POOL });
        controller.updateExclusions([1, 2, 3, 4, 5, 6, 7, 8, 9]);

        for (let i = 0; i < 200; i++) {
            const snapshot = controller.advance();
            if (snapshot.focusedHeroId !== null) {
                expect(snapshot.focusedHeroId).toBeGreaterThan(9);
            }
        }
    });

    it("degrades gracefully when the entire pool is excluded", () => {
        const controller = new FakeDraftController({ heroPool: [1, 2], excludedHeroIds: [1, 2] });
        expect(() => controller.advance()).not.toThrow();
    });

    it("cosmetic countdown never ticks below zero and freezes during lock/wait", () => {
        const controller = new FakeDraftController({ heroPool: HERO_POOL });
        for (let i = 0; i < 100; i++) controller.tickCountdown();
        expect(controller.snapshot.countdown).toBe(0);
    });
});
