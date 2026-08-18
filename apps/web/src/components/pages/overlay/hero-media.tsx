import { useState } from "react";
import styles from "./hero-media.module.scss";

interface HeroMediaProps {
    videoSrc: string;
    imageSrc: string;
    title: string;
    className?: string;
}

// video -> static portrait -> neutral placeholder, in strict priority order -
// exactly one representation is ever mounted at a time (never layered via
// opacity/blend-mode), so a successfully playing video can never show a
// second depiction of the same hero underneath it. The <video> stays
// mounted-but-invisible while loading/not-yet-playing so it can actually
// reach a ready/error state; the portrait is removed from the DOM entirely
// the moment the video is confirmed playing, and only remounts if the video
// later stalls/errors.
export const HeroMedia = ({ videoSrc, imageSrc, title, className }: HeroMediaProps) => {
    const [videoReady, setVideoReady] = useState(false);
    const [videoFailed, setVideoFailed] = useState(false);
    const [imageFailed, setImageFailed] = useState(false);

    const showVideo = videoReady && !videoFailed;
    const showImage = !showVideo && !imageFailed;
    const showPlaceholder = !showVideo && !showImage;

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
                    src={videoSrc}
                    title={title}
                    className={styles.video}
                    preload="auto"
                    autoPlay
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
