import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HeroMedia } from "./hero-media";

afterEach(cleanup);

const renderMedia = () =>
    render(
        <HeroMedia videoSrc="/video.webm" imageSrc="/portrait.png" title="Pudge" />
    );

describe("HeroMedia", () => {
    it("shows only the portrait before the video is ready - never both", () => {
        const { container } = renderMedia();
        expect(container.querySelector("img")).toBeTruthy();
        // video stays mounted (loading) but is not the visible representation
        const video = container.querySelector("video");
        expect(video).toBeTruthy();
        expect(video?.style.opacity).toBe("0");
    });

    it("removes the portrait from the DOM entirely once the video is playing - no double representation", () => {
        const { container } = renderMedia();
        const video = container.querySelector("video") as HTMLVideoElement;

        fireEvent(video, new Event("canplay"));

        expect(container.querySelector("img")).toBeNull();
        expect(container.querySelectorAll("[aria-hidden]").length).toBe(0);
        expect(video.style.opacity).toBe("1");
    });

    it("falls back to the portrait if the video fails to load", () => {
        const { container } = renderMedia();
        const video = container.querySelector("video") as HTMLVideoElement;

        fireEvent(video, new Event("canplay"));
        expect(container.querySelector("img")).toBeNull();

        fireEvent(video, new Event("error"));

        expect(container.querySelector("video")).toBeNull();
        expect(container.querySelector("img")).toBeTruthy();
    });

    it("falls back to a neutral placeholder if neither video nor portrait is available", () => {
        const { container } = renderMedia();
        const video = container.querySelector("video") as HTMLVideoElement;
        const img = container.querySelector("img") as HTMLImageElement;

        fireEvent(video, new Event("error"));
        fireEvent.error(img);

        expect(container.querySelector("video")).toBeNull();
        expect(container.querySelector("img")).toBeNull();
        expect(container.querySelector("span[aria-hidden]")).toBeTruthy();
    });
});
