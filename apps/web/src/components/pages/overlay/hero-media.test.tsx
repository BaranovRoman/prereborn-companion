import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HeroMedia } from "./hero-media";

afterEach(cleanup);

const renderMedia = (props: Partial<Parameters<typeof HeroMedia>[0]> = {}) =>
    render(
        <HeroMedia videoSrc={props.videoSrc ?? "/video.webm"} imageSrc="/portrait.png" title="Pudge" {...props} />
    );

describe("HeroMedia - loading and terminal states", () => {
    it("shows a neutral placeholder (not the portrait) while the video is loading - portrait is not loading UI", () => {
        const { container } = renderMedia();
        // video stays mounted (loading) but is not the visible representation
        const video = container.querySelector("video");
        expect(video).toBeTruthy();
        expect(video?.style.opacity).toBe("0");
        expect(container.querySelector("img")).toBeNull();
        expect(container.querySelector("[aria-hidden]")).toBeTruthy();
    });

    it("loading -> ready -> playing: shows the video once ready, no portrait ever shown", () => {
        const { container } = renderMedia({ videoSrc: "/loading-ready.webm" });
        const video = container.querySelector("video") as HTMLVideoElement;

        fireEvent(video, new Event("loadeddata"));
        fireEvent(video, new Event("canplay"));
        fireEvent(video, new Event("playing"));

        expect(container.querySelector("img")).toBeNull();
        expect(container.querySelectorAll("[aria-hidden]").length).toBe(0);
        expect(video.style.opacity).toBe("1");
    });

    it("terminal video error: falls back to the portrait", () => {
        const { container } = renderMedia({ videoSrc: "/terminal-error.webm" });
        const video = container.querySelector("video") as HTMLVideoElement;

        fireEvent(video, new Event("canplay"));
        expect(container.querySelector("img")).toBeNull();

        fireEvent(video, new Event("error"));

        expect(container.querySelector("video")).toBeNull();
        expect(container.querySelector("img")).toBeTruthy();
    });

    it("portrait error after terminal video failure: falls back to the neutral placeholder", () => {
        const { container } = renderMedia({ videoSrc: "/both-fail.webm" });
        const video = container.querySelector("video") as HTMLVideoElement;

        fireEvent(video, new Event("error"));
        const img = container.querySelector("img") as HTMLImageElement;
        fireEvent.error(img);

        expect(container.querySelector("video")).toBeNull();
        expect(container.querySelector("img")).toBeNull();
        expect(container.querySelector("span[aria-hidden]")).toBeTruthy();
    });
});

// Root-cause regression: a video that already reached "ready" must never be
// replaced by the portrait again because of a transient buffering signal or
// a pause/resume cycle. See hero-media.tsx invariant comment.
describe("HeroMedia - a ready video never flickers back to the portrait", () => {
    it("playing -> waiting -> playing: portrait does not appear, video stays visible", () => {
        const { container } = renderMedia({ videoSrc: "/waiting-flap.webm" });
        const video = container.querySelector("video") as HTMLVideoElement;

        fireEvent(video, new Event("playing"));
        expect(video.style.opacity).toBe("1");

        fireEvent(video, new Event("waiting"));
        expect(container.querySelector("img")).toBeNull();
        expect(video.style.opacity).toBe("1");
        expect(container.querySelector("video")).toBe(video);

        fireEvent(video, new Event("playing"));
        expect(video.style.opacity).toBe("1");
    });

    it("playing -> stalled -> playing: portrait does not appear, video stays visible", () => {
        const { container } = renderMedia({ videoSrc: "/stalled-flap.webm" });
        const video = container.querySelector("video") as HTMLVideoElement;

        fireEvent(video, new Event("canplay"));
        expect(video.style.opacity).toBe("1");

        fireEvent(video, new Event("stalled"));
        expect(container.querySelector("img")).toBeNull();
        expect(video.style.opacity).toBe("1");

        fireEvent(video, new Event("playing"));
        expect(video.style.opacity).toBe("1");
    });

    it("ready video -> paused prop toggles for offscreen/onscreen -> portrait does not appear on resume", () => {
        const { container, rerender } = renderMedia({ videoSrc: "/pause-resume.webm", paused: false });
        const video = container.querySelector("video") as HTMLVideoElement;
        fireEvent(video, new Event("playing"));
        expect(video.style.opacity).toBe("1");

        // Card leaves the active radius - HeroCarouselCard flips paused=true.
        rerender(
            <HeroMedia videoSrc="/pause-resume.webm" imageSrc="/portrait.png" title="Pudge" paused={true} />
        );
        expect(container.querySelector("img")).toBeNull();
        expect(video.style.opacity).toBe("1");

        // Card re-enters the active radius - paused=false again.
        rerender(
            <HeroMedia videoSrc="/pause-resume.webm" imageSrc="/portrait.png" title="Pudge" paused={false} />
        );
        expect(container.querySelector("img")).toBeNull();
        expect(video.style.opacity).toBe("1");
    });
});

describe("HeroMedia - session readiness registry survives remount", () => {
    it("an already-ready hero (by src) does not visually pass through the loading/portrait state on a fresh mount in the same session", () => {
        const src = "/already-ready-this-session.webm";
        const first = renderMedia({ videoSrc: src });
        const firstVideo = first.container.querySelector("video") as HTMLVideoElement;
        fireEvent(firstVideo, new Event("canplay"));
        expect(firstVideo.style.opacity).toBe("1");
        first.unmount();

        // Fresh HeroMedia instance, same src, same module-level session (no
        // reload happened) - must start already showing the video, not the
        // placeholder/portrait, even before any media event fires on this
        // new <video> element.
        const second = renderMedia({ videoSrc: src });
        const secondVideo = second.container.querySelector("video") as HTMLVideoElement;
        expect(secondVideo.style.opacity).toBe("1");
        expect(second.container.querySelector("img")).toBeNull();
        expect(second.container.querySelector("[aria-hidden]")).toBeNull();
    });

    it("a different src for the same remount does not inherit an unrelated src's ready status", () => {
        const readySrc = "/registry-isolated-ready.webm";
        const first = renderMedia({ videoSrc: readySrc });
        fireEvent(first.container.querySelector("video") as HTMLVideoElement, new Event("canplay"));
        first.unmount();

        const other = renderMedia({ videoSrc: "/registry-isolated-unrelated.webm" });
        const otherVideo = other.container.querySelector("video") as HTMLVideoElement;
        // Unrelated src has never been proven ready - must start in the
        // neutral loading state, not optimistically "ready".
        expect(otherVideo.style.opacity).toBe("0");
        expect(other.container.querySelector("[aria-hidden]")).toBeTruthy();
    });
});
