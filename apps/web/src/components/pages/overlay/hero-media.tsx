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

// video -> static portrait -> neutral placeholder, in strict priority order -
// exactly one representation is ever mounted at a time (never layered via
// opacity/blend-mode), so a successfully playing video can never show a
// second depiction of the same hero underneath it. The <video> stays
// mounted-but-invisible while loading/not-yet-playing so it can actually
// reach a ready/error state; the portrait is removed from the DOM entirely
// the moment the video is confirmed playing, and only remounts if the video
// later stalls/errors.
export const HeroMedia = ({ videoSrc, imageSrc, title, className, paused = false }: HeroMediaProps) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [videoReady, setVideoReady] = useState(false);
    const [videoFailed, setVideoFailed] = useState(false);
    const [imageFailed, setImageFailed] = useState(false);

    const showVideo = videoReady && !videoFailed;
    const showImage = !showVideo && !imageFailed;
    const showPlaceholder = !showVideo && !showImage;

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        // Swallow failures deliberately - a real playback/autoplay-policy
        // failure already surfaces through onError/onStalled above and
        // falls back to the portrait; this is only ever a best-effort nudge.
        try {
            if (paused) {
                video.pause();
            } else if (video.paused && videoReady) {
                video.play()?.catch?.(() => {});
            }
        } catch {
            // ignore
        }
    }, [paused, videoReady]);

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
            {!videoFailed && (
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
                    onLoadedData={() => setVideoReady(true)}
                    onCanPlay={() => setVideoReady(true)}
                    onPlaying={() => setVideoReady(true)}
                    onWaiting={() => setVideoReady(false)}
                    onStalled={() => setVideoReady(false)}
                    onError={() => {
                        setVideoReady(false);
                        setVideoFailed(true);
                    }}
                />
            )}
        </span>
    );
};
