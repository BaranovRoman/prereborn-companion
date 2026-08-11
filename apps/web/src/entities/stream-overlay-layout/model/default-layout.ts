import type { OverlayAspectRatio, OverlayLayout } from "./types";

export const DEFAULT_OVERLAY_ASPECT_RATIO: OverlayAspectRatio = {
    preset: "16:9",
    widthRatio: 16,
    heightRatio: 9,
    width: 1920,
    height: 1080,
};

// Зеркало backend-константы (services/stream-overlay-layout-service.ts) -
// используется как мгновенный фолбэк до первого ответа API (и на публичном
// overlay, и в редакторе), а также как цель кнопки "Вернуть по умолчанию" в
// редакторе. Раскладка воспроизводит сегодняшний вид (всё в левом верхнем
// углу, anchor "top-left" везде), companionStatus - новый виджет, которого
// раньше в HUD не было.
const gameplayWidgets: OverlayLayout["scenes"]["gameplay"]["widgets"] = {
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
};

export const DEFAULT_OVERLAY_LAYOUT: OverlayLayout = {
    version: 5,
    scenes: {
        gameplay: {
            widgets: gameplayWidgets,
            cameraZone: {
                enabled: true,
                anchor: "bottom-right",
                x: 1860,
                y: 1013,
                width: 400,
                height: 300,
            },
            minimapCover: { enabled: true, preset: "random-a", anchor: "bottom-left", x: 0, y: 0, size: 282 },
            gameplayProtection: { enabled: true, zones: [
                { id: "buyback-portraits", label: "Buyback portrait borders", enabled: true, x: 488, y: 0, width: 944, height: 76 },
            ] },
        },
        draft: {
            widgets: {
                ...gameplayWidgets,
                currentGame: { ...gameplayWidgets.currentGame, visible: false },
                recentMatches: {
                    ...gameplayWidgets.recentMatches,
                    xVw: 3,
                    yVh: 70,
                    recentMatches: { ...gameplayWidgets.recentMatches.recentMatches },
                },
            },
            cameraZone: {
                enabled: true,
                anchor: "bottom-left",
                x: 60,
                y: 1013,
                width: 400,
                height: 300,
            },
            minimapCover: { enabled: false, preset: "random-a", anchor: "bottom-left", x: 0, y: 0, size: 282 },
            gameplayProtection: { enabled: false, zones: [] },
        },
    },
    aspectRatio: DEFAULT_OVERLAY_ASPECT_RATIO,
    draftProtection: { mode: "cover" },
};
