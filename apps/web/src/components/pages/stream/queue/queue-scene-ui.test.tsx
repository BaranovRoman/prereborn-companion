import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PreloadedVideo } from "./queue-scene-ui";

afterEach(cleanup);

// Regression coverage for the WK-77 follow-up "Between Matches hero media
// disappears/reappears" bug. Root cause: commit e09e29d ("Simplify hero
// video presentation") dropped the `poster` prop from both real call sites
// (FeaturedMatch/FavoriteHeroes) while `onWaiting`/`onStalled` still hid the
// video - the same flicker bug hero-media.tsx separately fixed. With no
// poster to fall back to, a transient buffering event on an already-playing
// video produced a fully blank card. These tests pin the fixed contract:
// poster is passed and stays the fallback, and once ready the video is
// sticky through waiting/stalled/pause, mirroring hero-media.test.tsx's
// invariant tests for the other hero-media implementation in this app.
describe("PreloadedVideo (Between Matches hero media)", () => {
    it("shows the poster while the video is loading, not a blank card", () => {
        const { container } = render(
            <PreloadedVideo src="/video.webm" poster="/portrait.png" className="hero" />
        );
        const video = container.querySelector("video") as HTMLVideoElement;
        const img = container.querySelector("img") as HTMLImageElement;

        expect(video.style.opacity).toBe("0");
        expect(img).toBeTruthy();
        expect(img.src).toContain("/portrait.png");
    });

    it("portrait -> playing video: poster is removed once the video is ready", () => {
        const { container } = render(
            <PreloadedVideo src="/video.webm" poster="/portrait.png" className="hero" />
        );
        const video = container.querySelector("video") as HTMLVideoElement;

        fireEvent(video, new Event("loadeddata"));
        fireEvent(video, new Event("playing"));

        expect(video.style.opacity).toBe("1");
        expect(container.querySelector("img")).toBeNull();
    });

    it("playing -> waiting -> playing: the video never goes blank again", () => {
        const { container } = render(
            <PreloadedVideo src="/video.webm" poster="/portrait.png" className="hero" />
        );
        const video = container.querySelector("video") as HTMLVideoElement;

        fireEvent(video, new Event("playing"));
        expect(video.style.opacity).toBe("1");

        fireEvent(video, new Event("waiting"));
        expect(video.style.opacity).toBe("1");
        expect(container.querySelector("img")).toBeNull();

        fireEvent(video, new Event("playing"));
        expect(video.style.opacity).toBe("1");
    });

    it("playing -> stalled -> playing: the video never goes blank again", () => {
        const { container } = render(
            <PreloadedVideo src="/video.webm" poster="/portrait.png" className="hero" />
        );
        const video = container.querySelector("video") as HTMLVideoElement;

        fireEvent(video, new Event("canplay"));
        expect(video.style.opacity).toBe("1");

        fireEvent(video, new Event("stalled"));
        expect(video.style.opacity).toBe("1");

        fireEvent(video, new Event("playing"));
        expect(video.style.opacity).toBe("1");
    });

    it("a ready video does not go blank on pause (e.g. tab losing focus)", () => {
        const { container } = render(
            <PreloadedVideo src="/video.webm" poster="/portrait.png" className="hero" />
        );
        const video = container.querySelector("video") as HTMLVideoElement;

        fireEvent(video, new Event("playing"));
        fireEvent(video, new Event("pause"));

        expect(video.style.opacity).toBe("1");
        expect(container.querySelector("img")).toBeNull();
    });

    it("terminal error falls back to (and stays on) the poster", () => {
        const { container } = render(
            <PreloadedVideo src="/video.webm" poster="/portrait.png" className="hero" />
        );
        const video = container.querySelector("video") as HTMLVideoElement;

        fireEvent(video, new Event("playing"));
        fireEvent(video, new Event("error"));

        expect(video.style.opacity).toBe("0");
        expect(container.querySelector("img")).toBeTruthy();

        // A late waiting/stalled after a terminal error must not resurrect
        // the video without a poster.
        fireEvent(video, new Event("waiting"));
        expect(container.querySelector("img")).toBeTruthy();
    });

    it("without a poster prop, loading is still visually distinct from a silently blank card", () => {
        // Regression guard for the exact missing-prop bug: if a future call
        // site forgets `poster` again, the video is still mounted at
        // opacity 0 (not literally invisible content removed from the DOM),
        // so this is at least detectable/debuggable rather than a silent
        // empty card - but real call sites must always pass a poster.
        const { container } = render(<PreloadedVideo src="/video.webm" className="hero" />);
        const video = container.querySelector("video") as HTMLVideoElement;
        expect(video.style.opacity).toBe("0");
        expect(container.querySelector("img")).toBeNull();
    });
});
