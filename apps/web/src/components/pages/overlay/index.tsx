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
import { getActiveScene } from "./lib/get-active-scene";
import { selectRecentMatches } from "./lib/select-recent-matches";
import { ViewerAlertToast } from "@/components/pages/stream/queue/viewer-alert-toast";

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
    // WK-53 - "ended" (see get-active-scene.ts) wins over EVERYTHING else,
    // including a manual OBS test sceneOverride: once the stream has been
    // explicitly ended, the public overlay must render the calm final scene,
    // full stop - a stale/reconnecting GSI tick from a Companion that's
    // still running (see get-broadcast-scene.ts) must never be able to pull
    // it back into gameplay/draft. The backend also already nulls out
    // `companion.payload` in this state as defense in depth (see
    // controllers/stream/overlay.ts), so reading it here is harmless even if
    // this precedence were ever bypassed.
    const activeScene = getActiveScene({
        sessionState: data.sessionState,
        sceneOverride: data.sceneOverride,
        companionIsOnline: data.companion.isOnline,
        companionPayload: data.companion.payload,
        draftProtectionMode: layout.draftProtection.mode,
    });

    // WK-72 - ViewerAlertToast is rendered once, below, OUTSIDE this branch:
    // it must occupy the same position in the tree on every render so React
    // never unmounts/remounts it on a scene switch (betweenMatches <->
    // draft/gameplay) - a remount would reset its internal dedup/queue
    // state and could re-show an alert that already played before the
    // switch. Mounting it per-branch (or only in the betweenMatches
    // fragment) was the original, incorrect approach.
    const sceneContent = activeScene === "streamEnded" || activeScene === "betweenMatches" ? (
        <QueueScene
            quality="high"
            seed={1}
            debug={false}
            forceFallback={false}
            publicData={data}
        />
    ) : (
        (() => {
            const widgets = layout.scenes[activeScene].widgets;
            // A manual "Тест сцен OBS" test carries its own draftProtection.mode
            // snapshot (see obs-scene-command-service.ts) - preferred over `layout`
            // while active so a re-test always reflects exactly what was just saved,
            // without depending on `layout` being re-fetched at the same instant.
            const draftProtectionMode =
                activeScene === "draft"
                    ? data.draftProtectionModeOverride ?? layout.draftProtection.mode
                    : undefined;
            return (
                <OverlayCanvas
                    mode="live"
                    aspectRatio={layout.aspectRatio}
                    minimapCover={layout.scenes[activeScene].minimapCover}
                    draftProtectionMode={draftProtectionMode}
                    draftProtectionText={
                        draftProtectionMode ? layout.draftProtection.text : undefined
                    }
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
            );
        })()
    );

    return (
        <>
            {sceneContent}
            <ViewerAlertToast viewerEvents={data.viewerEvents} viewerAlertsSettings={data.viewerAlertsSettings} />
            {debug && <DebugPanel companion={data.companion} scale={scale} />}
        </>
    );
};
