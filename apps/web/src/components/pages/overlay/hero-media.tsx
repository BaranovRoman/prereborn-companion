import { useState } from "react";
import styles from "./hero-media.module.scss";

interface HeroMediaProps {
    videoSrc: string;
    imageSrc: string;
    title: string;
    className?: string;
}

// Общий "видео поверх статичной картинки" паттерн - см. widgets/current-game.tsx
// (HeroVideo). imageSrc всегда виден под видео, поэтому падение/зависание/
// ошибка video (недоступен hosting, медленная сеть) не оставляет пустое
// место - зритель всегда видит хотя бы статичный hero image.
export const HeroMedia = ({ videoSrc, imageSrc, title, className }: HeroMediaProps) => {
    const [videoReady, setVideoReady] = useState(false);

    return (
        <span className={`${styles.media} ${className ?? ""}`}>
            <img src={imageSrc} alt="" aria-hidden="true" className={styles.image} />
            <video
                src={videoSrc}
                title={title}
                className={styles.video}
                preload="auto"
                autoPlay
                loop
                muted
                playsInline
                onLoadedData={() => setVideoReady(true)}
                onCanPlay={() => setVideoReady(true)}
                onPlaying={() => setVideoReady(true)}
                onWaiting={() => setVideoReady(false)}
                onStalled={() => setVideoReady(false)}
                onError={() => setVideoReady(false)}
                style={{ opacity: videoReady ? 1 : 0 }}
            />
        </span>
    );
};
