import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DOTA_HEROES_BY_NAME } from "@/entities/dota-hero/model/heroes";
import { HeroCarousel } from "./hero-carousel";

afterEach(cleanup);

// A stable slice of real hero ids, alphabetic order preserved (matches how
// fake-draft-picker.tsx builds HERO_POOL) - guarantees getHeroById resolves
// every id used below.
const ROSTER = DOTA_HEROES_BY_NAME.slice(0, 20).map((hero) => hero.id);

const findVideo = (container: HTMLElement, heroId: number) =>
    container.querySelector(`[data-hero-id="${heroId}"] video`);

describe("HeroCarousel DOM identity across carousel movement", () => {
    it("does not remount a card's <video> element when the center index moves to a neighbor (WK-77 flicker root cause B)", () => {
        const centerHeroId = ROSTER[10];
        const neighborHeroId = ROSTER[11];
        const { container, rerender } = render(
            <HeroCarousel roster={ROSTER} centerHeroId={centerHeroId} cycleId={1} locked={false} />
        );

        const videoBefore = findVideo(container, neighborHeroId);
        expect(videoBefore).toBeTruthy();

        // Same cycleId - a hop within the same fake-pick session, not a new
        // one. The mount window only ever widens immediately (to preload the
        // sweep path); it never shrinks synchronously, so a neighbor well
        // inside the window must keep the exact same DOM node.
        rerender(<HeroCarousel roster={ROSTER} centerHeroId={neighborHeroId} cycleId={1} locked={false} />);

        const videoAfter = findVideo(container, neighborHeroId);
        expect(videoAfter).toBeTruthy();
        expect(videoAfter).toBe(videoBefore);
    });

    it("preserves DOM identity for a hero that stays within the overscan window across several hops", () => {
        const anchorHeroId = ROSTER[10];
        const { container, rerender } = render(
            <HeroCarousel roster={ROSTER} centerHeroId={anchorHeroId} cycleId={1} locked={false} />
        );

        const initialVideo = findVideo(container, anchorHeroId);
        expect(initialVideo).toBeTruthy();

        // Several small hops in a row (center drifts away from and back
        // toward the anchor hero), all within the same session/cycle.
        const hops = [ROSTER[11], ROSTER[9], ROSTER[12], ROSTER[8], ROSTER[10]];
        for (const heroId of hops) {
            rerender(<HeroCarousel roster={ROSTER} centerHeroId={heroId} cycleId={1} locked={false} />);
        }

        const finalVideo = findVideo(container, anchorHeroId);
        expect(finalVideo).toBeTruthy();
        expect(finalVideo).toBe(initialVideo);
    });

    it("starts a fresh mount window (new DOM) on a new fake-pick session (cycleId change) - this is the expected/allowed case", () => {
        const firstHeroId = ROSTER[10];
        const { container, rerender } = render(
            <HeroCarousel roster={ROSTER} centerHeroId={firstHeroId} cycleId={1} locked={false} />
        );
        expect(findVideo(container, firstHeroId)).toBeTruthy();

        const secondHeroId = ROSTER[2];
        rerender(<HeroCarousel roster={ROSTER} centerHeroId={secondHeroId} cycleId={2} locked={false} />);

        // The new session's center is mounted; the old session's far-away
        // center is legitimately gone (outside the new overscan window) -
        // this is intentional bounded-window eviction, not a bug.
        expect(findVideo(container, secondHeroId)).toBeTruthy();
    });
});

// WK-77 follow-up (OBS perf): only center ± PLAYING_RADIUS should actually
// call video.play() - everything else in the wider mount window is present
// in the DOM (preloaded / showing its last decoded frame) but not
// autoplaying, so it isn't also paying continuous decode cost. See
// hero-carousel.tsx's PLAYING_RADIUS vs ACTIVE_RADIUS vs OVERSCAN_RADIUS
// doc comments for why these are three separate radii now.
describe("HeroCarousel tiered playback", () => {
    it("plays only the center and its immediate neighbor; farther mounted cards are paused but present", () => {
        const centerHeroId = ROSTER[10];
        const { container } = render(
            <HeroCarousel roster={ROSTER} centerHeroId={centerHeroId} cycleId={1} locked={false} />
        );

        const centerVideo = findVideo(container, centerHeroId) as HTMLVideoElement;
        const playingNeighbor = findVideo(container, ROSTER[11]) as HTMLVideoElement; // distance 1
        // distance 3 - inside ACTIVE_RADIUS (visible/preloaded) but outside
        // PLAYING_RADIUS - must be mounted, must not autoplay.
        const pausedButMounted = findVideo(container, ROSTER[13]) as HTMLVideoElement;
        // distance 6 - inside OVERSCAN_RADIUS only (preload-ahead window).
        const overscanOnly = findVideo(container, ROSTER[16]) as HTMLVideoElement;

        expect(centerVideo.autoplay).toBe(true);
        expect(playingNeighbor.autoplay).toBe(true);
        expect(pausedButMounted).toBeTruthy();
        expect(pausedButMounted.autoplay).toBe(false);
        expect(overscanOnly).toBeTruthy();
        expect(overscanOnly.autoplay).toBe(false);
    });
});
