"use client";

import { QueueTreeLayers } from "@/components/pages/stream/queue/queue-tree-layers";
import { RedFogBackground, type RedFogDebugState } from "@/components/pages/stream/queue/red-fog-background";
import queueStyles from "@/components/pages/stream/queue/queue-scene.module.scss";
import styles from "./draft-scene-background.module.scss";

interface DraftSceneBackgroundProps {
    seed: number;
}

const ignoreDebugState: (state: RedFogDebugState) => void = () => {};

// Тот же атмосферный фон (fallback-градиент + деревья + WebGL2 red-fog шейдер
// + виньетка), что уже используется на /stream/queue и на сайте в целом
// (см. shared/ui/app-atmosphere) - переиспользуется как есть, шейдер не
// трогается. Единственное добавление - .dim поверх виньетки, чтобы hero
// showcase/carousel оставались читаемыми поверх активного фона (см. задачу:
// "если shader слишком активный, используй существующие параметры/overlay/
// dimming, а не переписывай его").
export const DraftSceneBackground = ({ seed }: DraftSceneBackgroundProps) => (
    <div className={styles.stage} aria-hidden="true">
        <div className={queueStyles.fallback} />
        <QueueTreeLayers />
        <RedFogBackground
            quality="medium"
            seed={seed}
            forceFallback={false}
            onDebugStateChange={ignoreDebugState}
        />
        <div className={queueStyles.atmosphereFinish} />
        <div className={styles.dim} />
    </div>
);
