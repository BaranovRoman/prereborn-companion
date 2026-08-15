import type { OverlaySceneLayout } from "@/entities/stream-overlay-layout/model/types";

export interface OverlayLayoutPreset {
    id: string;
    label: string;
    description: string;
    layout: OverlaySceneLayout;
}

// Готовые раскладки (см. задачу, п.5) - применяются целиком в draft
// (OverlayEditorPage.applyPreset), ничего не сохраняется, пока пользователь
// не нажмёт "Сохранить". Точные координаты - разумная отправная точка,
// пользователь может подвинуть блоки вручную после применения.
export const OVERLAY_LAYOUT_PRESETS: OverlayLayoutPreset[] = [
    {
        id: "classic",
        label: "Classic",
        description: "История и герой слева, рейтинг и статус справа сверху",
        layout: {
            widgets: {
                recentMatches: {
                    xVw: 3,
                    yVh: 4,
                    scale: 1,
                    visible: true,
                    anchor: "top-left",
                    recentMatches: {
                        limit: 5,
                        source: "current-stream",
                        direction: "newest-first",
                        compact: true,
                    },
                },
                currentGame: {
                    xVw: 3,
                    yVh: 20,
                    scale: 1,
                    visible: true,
                    anchor: "top-left",
                },
                session: {
                    xVw: 97,
                    yVh: 4,
                    scale: 1,
                    visible: true,
                    anchor: "top-right",
                },
                companionStatus: {
                    xVw: 97,
                    yVh: 14,
                    scale: 1,
                    visible: true,
                    anchor: "top-right",
                },
            },
            cameraZone: { enabled: true, anchor: "bottom-right", x: 1860, y: 1013, width: 400, height: 300 },
            minimapCover: { enabled: true, preset: "random-a", anchor: "bottom-left", x: 0, y: 0, size: 282 },
        },
    },
    {
        id: "bottom",
        label: "Bottom",
        description: "Всё внизу экрана - привычно для 16:9 трансляций",
        layout: {
            widgets: {
                recentMatches: {
                    xVw: 3,
                    yVh: 97,
                    scale: 1,
                    visible: true,
                    anchor: "bottom-left",
                    recentMatches: {
                        limit: 5,
                        source: "current-stream",
                        direction: "newest-first",
                        compact: true,
                    },
                },
                currentGame: {
                    xVw: 50,
                    yVh: 97,
                    scale: 1,
                    visible: true,
                    anchor: "bottom-center",
                },
                session: {
                    xVw: 97,
                    yVh: 97,
                    scale: 1,
                    visible: true,
                    anchor: "bottom-right",
                },
                companionStatus: {
                    xVw: 97,
                    yVh: 4,
                    scale: 1,
                    visible: true,
                    anchor: "top-right",
                },
            },
            cameraZone: { enabled: true, anchor: "bottom-right", x: 1860, y: 1013, width: 400, height: 300 },
            minimapCover: { enabled: true, preset: "random-a", anchor: "bottom-left", x: 0, y: 0, size: 282 },
        },
    },
    {
        id: "compact",
        label: "Compact",
        description: "Всё компактной группой в одном углу, поменьше масштаб",
        layout: {
            widgets: {
                session: {
                    xVw: 3,
                    yVh: 4,
                    scale: 0.85,
                    visible: true,
                    anchor: "top-left",
                },
                currentGame: {
                    xVw: 3,
                    yVh: 13,
                    scale: 0.85,
                    visible: true,
                    anchor: "top-left",
                },
                recentMatches: {
                    xVw: 3,
                    yVh: 22,
                    scale: 0.85,
                    visible: true,
                    anchor: "top-left",
                    recentMatches: {
                        limit: 3,
                        source: "current-stream",
                        direction: "newest-first",
                        compact: true,
                    },
                },
                companionStatus: {
                    xVw: 3,
                    yVh: 40,
                    scale: 0.85,
                    visible: true,
                    anchor: "top-left",
                },
            },
            cameraZone: { enabled: true, anchor: "bottom-right", x: 1860, y: 1013, width: 400, height: 300 },
            minimapCover: { enabled: true, preset: "random-a", anchor: "bottom-left", x: 0, y: 0, size: 282 },
        },
    },
    {
        id: "clean",
        label: "Clean",
        description: "Только рейтинг и W/L, остальное скрыто",
        layout: {
            widgets: {
                session: {
                    xVw: 3,
                    yVh: 4,
                    scale: 1,
                    visible: true,
                    anchor: "top-left",
                },
                currentGame: {
                    xVw: 3,
                    yVh: 12,
                    scale: 1,
                    visible: false,
                    anchor: "top-left",
                },
                recentMatches: {
                    xVw: 3,
                    yVh: 22,
                    scale: 1,
                    visible: false,
                    anchor: "top-left",
                    recentMatches: {
                        limit: 5,
                        source: "current-stream",
                        direction: "newest-first",
                        compact: true,
                    },
                },
                companionStatus: {
                    xVw: 3,
                    yVh: 92,
                    scale: 1,
                    visible: false,
                    anchor: "top-left",
                },
            },
            cameraZone: { enabled: true, anchor: "bottom-right", x: 1860, y: 1013, width: 400, height: 300 },
            minimapCover: { enabled: true, preset: "random-a", anchor: "bottom-left", x: 0, y: 0, size: 282 },
        },
    },
];
