import type { CSSProperties } from "react";
import type { MinimapCoverSettings, MinimapCoverPreset } from "@/entities/stream-overlay-layout/model/types";
import styles from "./anti-snipe-layer.module.scss";

interface AntiSnipeLayerProps {
    sceneWidth: number;
    sceneHeight: number;
    settings?: MinimapCoverSettings;
}

type Ward = { id: number; x: number; y: number; dx: number; dy: number; team: "radiant" | "dire"; kind: "observer" | "sentry"; duration: number; delay: number };

const counts: Record<MinimapCoverPreset, number> = {
    clean: 0,
    "random-a": 22,
    "random-b": 26,
    "random-dense": 42,
    interactive: 28,
};

const seeds: Record<MinimapCoverPreset, number> = {
    clean: 1,
    "random-a": 7401,
    "random-b": 7402,
    "random-dense": 7403,
    interactive: 7404,
};

export const createMinimapWards = (preset: MinimapCoverPreset): Ward[] => {
    let state = seeds[preset];
    const random = () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
    };
    return Array.from({ length: counts[preset] }, (_, id) => ({
        id,
        x: 7 + random() * 86,
        y: 7 + random() * 86,
        dx: (random() - 0.5) * 13,
        dy: (random() - 0.5) * 13,
        team: random() > 0.48 ? "radiant" : "dire",
        kind: random() > 0.38 ? "observer" : "sentry",
        duration: 3.8 + random() * 5.2,
        delay: -random() * 7,
    }));
};

export const AntiSnipeLayer = ({ settings }: AntiSnipeLayerProps) => {
    if (!settings?.enabled) return null;

    const vertical = settings.anchor.startsWith("bottom") ? { bottom: settings.y } : { top: settings.y };
    const horizontal = settings.anchor.endsWith("right") ? { right: settings.x } : { left: settings.x };
    const interactive = settings.preset === "interactive";

    return (
        <div className={styles.minimapCover} aria-hidden="true" style={{ width: settings.size, height: settings.size, ...vertical, ...horizontal }}>
            <img className={styles.mapBase} src="/generated/chatgpt/dota-current-clean-minimap.png" alt="" draggable={false} />
            <div className={styles.wardLayer}>
                {createMinimapWards(settings.preset).map((ward) => (
                    <span
                        key={ward.id}
                        className={`${styles.ward} ${styles[ward.kind]} ${styles[ward.team]} ${interactive ? styles.moving : ""}`}
                        style={{
                            "--x": `${ward.x}%`, "--y": `${ward.y}%`, "--dx": `${ward.dx}%`, "--dy": `${ward.dy}%`,
                            "--duration": `${ward.duration}s`, "--delay": `${ward.delay}s`,
                        } as CSSProperties}
                    />
                ))}
            </div>
        </div>
    );
};
