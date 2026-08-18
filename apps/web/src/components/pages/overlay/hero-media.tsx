import { useEffect, useRef, useState } from "react";
import styles from "./hero-media.module.scss";

interface HeroMediaProps {
    videoSrc: string;
    imageSrc: string;
    title: string;
    className?: string;
    // Off by default (matches the previous always-autoplay behaviour). Set
    // true for cards that are mounted for preload/cache purposes but are
    // currently outside the carousel's active window - the video stays
    // buffered (preload="auto") but stops decoding/playing frames, and
    // resumes instantly once it re-enters the active window (see
    // hero-carousel.tsx: ACTIVE_RADIUS vs OVERSCAN_RADIUS).
    paused?: boolean;
}

type MediaStatus = "loading" | "ready" | "failed";

// Session-level (in-memory, tab-lifetime) readiness cache - NOT a persistent
// disk cache/service worker, and separate from the browser's own HTTP cache
// (which keeps doing its normal job underneath this). Keyed by the actual
// video src rather than heroId, because the same hero uses different video
// fields in different scenes (featuredVideoUrl in the carousel, videoUrl in
// cinematic-draft) - the src is what was actually proven playable.
//
// Root cause (see WK-77 hero-video flicker task): the carousel's
// overscan/mount window (hero-carousel.tsx) evicts cards more than
// OVERSCAN_RADIUS away from the settle point on every hop completion, and a
// hero drifting in and out of that radius via back-and-forth hops
// genuinely remounts its HeroMedia instance - confirmed live (one hero
// remounted 8 times in 25s while the carousel idled/scrolled). A fresh
// mount always started from "loading" (-> portrait) with no memory of the
// fact this exact video already played successfully moments earlier. This
// registry lets a fresh mount skip straight to "ready" instead.
const mediaReadiness = new Map<string, MediaStatus>();

// video -> static portrait -> neutral placeholder, in strict priority order -
// exactly one representation is ever mounted at a time (never layered via
// opacity/blend-mode). Status only ever moves forward within one mount:
// loading -> ready (sticky) or loading -> failed (sticky) - see invariant
// below. A new src (different hero/URL) resets to whatever the registry
// already knows about *that* src, not the previous src's status.
//
// Invariant (root cause fix): once a src reaches "ready" - confirmed via
// loadeddata/canplay/playing - waiting/stalled/pause must NEVER flip it back
// to "loading" or reveal the portrait. Those events fire on the very
// <video> element that is already showing a decoded frame; browsers keep
// that frame on screen through a stall on their own. The ONLY way back to
// "portrait" is a genuine terminal `error`. Previously onWaiting/onStalled
// called setVideoReady(false), which - for an element that was already
// playing - immediately swapped the visible portrait back in for no reason
// (the actual flicker bug), and made the paused/resume effect below refuse
// to resume playback (it required videoReady===true) if that happened while
// a card was inactive.
export const HeroMedia = ({ videoSrc, imageSrc, title, className, paused = false }: HeroMediaProps) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [status, setStatus] = useState<MediaStatus>(() => mediaReadiness.get(videoSrc) ?? "loading");
    const [imageFailed, setImageFailed] = useState(false);

    // Different src (different hero, or the same hero's field resolved to a
    // new URL) - re-derive from the registry for THAT src rather than
    // carrying over this component instance's previous status. Adjusting
    // state during render (react.dev pattern - same one already used in
    // fake-draft-controller.ts's useFakeDraftController) rather than an
    // effect, so this src's correct status is what actually gets painted,
    // not a stale "loading" frame followed by a correction one tick later.
    const [prevVideoSrc, setPrevVideoSrc] = useState(videoSrc);
    if (prevVideoSrc !== videoSrc) {
        setPrevVideoSrc(videoSrc);
        setStatus(mediaReadiness.get(videoSrc) ?? "loading");
        setImageFailed(false);
    }

    const markReady = () => {
        mediaReadiness.set(videoSrc, "ready");
        if (status !== "ready") setStatus("ready");
    };

    const markFailed = () => {
        mediaReadiness.set(videoSrc, "failed");
        setStatus("failed");
    };

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        // Swallow failures deliberately - a real playback/autoplay-policy
        // failure already surfaces through onError above and falls back to
        // the portrait; this is only ever a best-effort nudge. Not gated on
        // status==="ready" - a distant card that becomes active again must
        // resume even if it hasn't fired its own ready event yet.
        try {
            if (paused) {
                video.pause();
            } else if (video.paused) {
                video.play()?.catch?.(() => {});
            }
        } catch {
            // ignore
        }
    }, [paused, videoSrc]);

    const showVideo = status === "ready";
    const showImage = status === "failed" && !imageFailed;
    const showPlaceholder = status === "loading" || (status === "failed" && imageFailed);

    return (
        <span className={`${styles.media} ${className ?? ""}`}>
            {showImage && (
                <img
                    src={imageSrc}
                    alt=""
                    aria-hidden="true"
                    className={styles.image}
                    onError={() => setImageFailed(true)}
                />
            )}
            {showPlaceholder && <span className={styles.placeholder} aria-hidden="true" />}
            {status !== "failed" && (
                <video
                    ref={videoRef}
                    src={videoSrc}
                    title={title}
                    className={styles.video}
                    preload="auto"
                    autoPlay={!paused}
                    loop
                    muted
                    playsInline
                    style={{ opacity: showVideo ? 1 : 0 }}
                    onLoadedData={markReady}
                    onCanPlay={markReady}
                    onPlaying={markReady}
                    onError={markFailed}
                />
            )}
        </span>
    );
};
