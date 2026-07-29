import type { OverlayAspectRatio, OverlayLayout } from "./types";

export const DEFAULT_OVERLAY_ASPECT_RATIO: OverlayAspectRatio = {
    preset: "16:9",
    widthRatio: 16,
    heightRatio: 9,
};

// Зеркало backend-константы (services/stream-overlay-layout-service.ts) -
// используется как мгновенный фолбэк до первого ответа API (и на публичном
// overlay, и в редакторе), а также как цель кнопки "Вернуть по умолчанию" в
// редакторе. Раскладка воспроизводит сегодняшний вид (всё в левом верхнем
// углу, anchor "top-left" везде), companionStatus - новый виджет, которого
// раньше в HUD не было.
export const DEFAULT_OVERLAY_LAYOUT: OverlayLayout = {
    version: 1,
    widgets: {
        session: { xVw: 3, yVh: 4, scale: 1, visible: true, anchor: "top-left" },
        currentGame: {
            xVw: 3,
            yVh: 12,
            scale: 1,
            visible: true,
            anchor: "top-left",
        },
        recentMatches: {
            xVw: 3,
            yVh: 22,
            scale: 1,
            visible: true,
            anchor: "top-left",
            recentMatches: {
                limit: 5,
                direction: "newest-first",
                compact: true,
            },
        },
        companionStatus: {
            xVw: 3,
            yVh: 92,
            scale: 1,
            visible: true,
            anchor: "top-left",
        },
    },
    aspectRatio: DEFAULT_OVERLAY_ASPECT_RATIO,
};
