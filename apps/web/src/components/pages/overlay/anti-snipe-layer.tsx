import type { AntiSnipeSettings, DotaGamePhase } from "@/entities/stream-overlay-layout/model/future";

interface AntiSnipeLayerProps {
    sceneWidth: number;
    sceneHeight: number;
    settings?: AntiSnipeSettings;
    gamePhase?: DotaGamePhase;
}

// Точка расширения под будущие anti-streamsniping маски (см. задачу, п.12-13)
// - draft pick/hero reveal, minimap, buyback, gold, cooldown-индикаторы,
// каждый независимым переключателем. Пока полностью выключен - возвращает
// null, ничего не рисует и не рендерит DOM в живом overlay (см. задачу, п.10).
export const AntiSnipeLayer = (_props: AntiSnipeLayerProps) => null;
