"use client";

import { useState } from "react";
import {
    QUEUE_QUALITY_CONFIG,
    type QueueQuality,
} from "./queue-scene-config";
import {
    RedFogBackground,
    type RedFogDebugState,
} from "./red-fog-background";
import { QueueTreeLayers } from "./queue-tree-layers";
import { QueueSceneUi } from "./queue-scene-ui";
import type { OverlayData } from "@/entities/stream-session/model/types";
import styles from "./queue-scene.module.scss";

interface QueueSceneProps {
    quality: QueueQuality;
    seed: number;
    debug: boolean;
    forceFallback: boolean;
    publicData?: OverlayData;
}

export const QueueScene = ({
    quality,
    seed,
    debug,
    forceFallback,
    publicData,
}: QueueSceneProps) => {
    const qualityConfig = QUEUE_QUALITY_CONFIG[quality];
    const [debugState, setDebugState] = useState<RedFogDebugState>({
        webgl2Available: false,
        renderWidth: 0,
        renderHeight: 0,
        targetFps: qualityConfig.targetFps,
        shaderStatus: "initializing",
        reducedMotion: false,
    });

    return (
        <main className={styles.scene} data-testid="queue-scene">
            <div className={styles.fallback} aria-hidden="true" />
            <QueueTreeLayers />
            <RedFogBackground
                quality={quality}
                seed={seed}
                forceFallback={forceFallback}
                onDebugStateChange={setDebugState}
            />
            <div className={styles.atmosphereFinish} aria-hidden="true" />
            <QueueSceneUi publicData={publicData} />

            {debug && (
                <section className={styles.content} aria-labelledby="queue-title">
                    <span className={styles.eyebrow}>
                        <span className={styles.statusDot} aria-hidden="true" />
                        Поиск игры
                    </span>
                    <h1 id="queue-title" className={styles.title}>
                        Поиск матча
                    </h1>
                    <p className={styles.subtitle}>Стрим защищён от снайпинга</p>
                </section>
            )}

            {debug && (
                <aside className={styles.debugPanel} data-testid="queue-debug">
                    <strong>Queue scene</strong>
                    <span>
                        WebGL2: {debugState.webgl2Available ? "available" : "unavailable"}
                    </span>
                    <span>Quality: {quality}</span>
                    <span>
                        Resolution: {debugState.renderWidth}×{debugState.renderHeight}
                    </span>
                    <span>Target FPS: {debugState.targetFps}</span>
                    <span>Shader: {debugState.shaderStatus}</span>
                    <span>Reduced motion: {debugState.reducedMotion ? "yes" : "no"}</span>
                    <span>Seed: {seed}</span>
                </aside>
            )}
        </main>
    );
};
