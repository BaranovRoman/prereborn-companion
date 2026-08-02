import styles from "./anti-snipe-layer.module.scss";
import type { MinimapCoverSettings } from "@/entities/stream-overlay-layout/model/types";

interface AntiSnipeLayerProps {
    sceneWidth: number;
    sceneHeight: number;
    settings?: MinimapCoverSettings;
}

// Точка расширения под будущие anti-streamsniping маски (см. задачу, п.12-13)
// - draft pick/hero reveal, minimap, buyback, gold, cooldown-индикаторы,
// каждый независимым переключателем. Пока полностью выключен - возвращает
// null, ничего не рисует и не рендерит DOM в живом overlay (см. задачу, п.10).
export const AntiSnipeLayer = ({ settings }: AntiSnipeLayerProps) => {
    if (!settings?.enabled) return null;

    const size = settings.size;
    const x = settings.x;
    const y = settings.y;
    const vertical = settings.anchor.startsWith("bottom") ? { bottom: y } : { top: y };
    const horizontal = settings.anchor.endsWith("right") ? { right: x } : { left: x };

    return (
        <img
            className={styles.minimapCover}
            src={`/vendor/community/anti-snipe/dota-7.40-fake-wards-${settings.preset}.png`}
            alt=""
            aria-hidden="true"
            draggable={false}
            style={{ width: size, height: size, ...vertical, ...horizontal }}
        />
    );
};
