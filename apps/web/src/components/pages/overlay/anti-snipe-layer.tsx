import styles from "./anti-snipe-layer.module.scss";

interface AntiSnipeLayerProps {
    sceneWidth: number;
    sceneHeight: number;
    showMinimap?: boolean;
}

// Точка расширения под будущие anti-streamsniping маски (см. задачу, п.12-13)
// - draft pick/hero reveal, minimap, buyback, gold, cooldown-индикаторы,
// каждый независимым переключателем. Пока полностью выключен - возвращает
// null, ничего не рисует и не рендерит DOM в живом overlay (см. задачу, п.10).
export const AntiSnipeLayer = ({ sceneWidth, sceneHeight, showMinimap = false }: AntiSnipeLayerProps) => {
    if (!showMinimap) return null;

    const scale = Math.min(sceneWidth / 1920, sceneHeight / 1080);
    const size = 282 * scale;

    return (
        <img
            className={styles.minimapCover}
            src="/vendor/community/anti-snipe/dota-7.40-fake-wards-balanced-a.png"
            alt=""
            aria-hidden="true"
            draggable={false}
            style={{ width: size, height: size }}
        />
    );
};
