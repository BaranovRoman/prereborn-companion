"use client";

import { useOverlayPolling } from "@/entities/stream-session/lib/use-overlay-polling";
import { DEFAULT_OVERLAY_LAYOUT } from "@/entities/stream-overlay-layout/model/default-layout";
import { normalizeOverlayLayout } from "@/entities/stream-overlay-layout/model/normalize-layout";
import type { OverlayData } from "@/entities/stream-session/model/types";
import { OverlayCanvas } from "./overlay-canvas";
import { AnchoredWidget } from "./anchored-widget";
import { SessionStats } from "./widgets/session-stats";
import { CurrentGame } from "./widgets/current-game";
import { RecentMatches } from "./widgets/recent-matches";
import { DebugPanel } from "./debug-panel";
import { QueueScene } from "@/components/pages/stream/queue/queue-scene";
import { getBroadcastScene } from "./lib/get-broadcast-scene";
import { selectRecentMatches } from "./lib/select-recent-matches";

interface OverlayPageProps {
    publicToken: string;
    initialData: OverlayData | null;
    debug?: boolean;
    scale?: number;
}

// Оркестратор сцены - рендерит ту же самую виртуальную сцену 1920x1080
// (OverlayCanvas, mode="live"), что и превью /stream/overlay-editor, только
// без safe area и без drag (AnchoredWidget без interactive - просто
// позиционированный div). Раньше живой overlay и editor-превью были двумя
// разными системами координат (vw/vh+clamp() vs проценты произвольного
// контейнера) - теперь это буквально один и тот же рендер-путь.
export const OverlayPage = ({
    publicToken,
    initialData,
    debug = false,
    scale,
}: OverlayPageProps) => {
    // Сайтовый Preloader для /overlay/:token не рендерится - см.
    // app/transition-provider.tsx (PreloaderWrapper распознаёт этот route по
    // usePathname() и пропускает и сам Preloader, и связанную с ним задержку
    // видимости) - поэтому здесь больше нет смысла вызывать
    // usePageReady()/ready(), раньше только закрывавший этот прелоадер.
    const data = useOverlayPolling(publicToken, initialData);

    if (!data) {
        return (
            <div
                aria-label="Overlay data unavailable"
                style={{ position: "fixed", inset: 0, background: "#070b14" }}
            />
        );
    }

    const layout = normalizeOverlayLayout(data.layout ?? DEFAULT_OVERLAY_LAYOUT);
    const derivedScene = getBroadcastScene(data.companion.payload);
    const activeScene =
        data.sceneOverride ??
        (!data.companion.isOnline && layout.draftProtection.mode !== "off"
            ? "draft"
            : derivedScene);

    if (activeScene === "betweenMatches") {
        return (
            <>
                <QueueScene
                    quality="high"
                    seed={1}
                    debug={false}
                    forceFallback={false}
                    publicData={data}
                />
                {debug && <DebugPanel companion={data.companion} scale={scale} />}
            </>
        );
    }

    const widgets = layout.scenes[activeScene].widgets;

    return (
        <>
            <OverlayCanvas
                mode="live"
                aspectRatio={layout.aspectRatio}
                minimapCover={layout.scenes[activeScene].minimapCover}
                draftProtectionMode={
                    activeScene === "draft" ? layout.draftProtection.mode : undefined
                }
                draftPayload={activeScene === "draft" ? data.companion.payload : undefined}
            >
                {({ sceneWidth, sceneHeight }) => (
                    <>
                        <AnchoredWidget
                            layout={widgets.session}
                            sceneWidth={sceneWidth}
                            sceneHeight={sceneHeight}
                        >
                            <SessionStats
                                rating={data.rating}
                                sessionRatingDelta={data.sessionRatingDelta}
                                wins={data.wins}
                                losses={data.losses}
                                gameMode={data.gameMode}
                            />
                        </AnchoredWidget>

                        <AnchoredWidget
                            layout={widgets.currentGame}
                            sceneWidth={sceneWidth}
                            sceneHeight={sceneHeight}
                        >
                            <CurrentGame lastHeroId={data.lastHeroId} />
                        </AnchoredWidget>

                        <AnchoredWidget
                            layout={widgets.recentMatches}
                            sceneWidth={sceneWidth}
                            sceneHeight={sceneHeight}
                        >
                            <RecentMatches
                                matches={selectRecentMatches(
                                    data,
                                    widgets.recentMatches.recentMatches.source
                                )}
                                settings={widgets.recentMatches.recentMatches}
                                anchor={widgets.recentMatches.anchor}
                            />
                        </AnchoredWidget>

                    </>
                )}
            </OverlayCanvas>

            {debug && <DebugPanel companion={data.companion} scale={scale} />}
        </>
    );
};
