"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { QueueTreeLayers } from "@/components/pages/stream/queue/queue-tree-layers";
import {
    RedFogBackground,
    type RedFogDebugState,
} from "@/components/pages/stream/queue/red-fog-background";
import queueStyles from "@/components/pages/stream/queue/queue-scene.module.scss";

const ignoreDebugState: (state: RedFogDebugState) => void = () => {};

export const AppAtmosphere = () => {
    const pathname = usePathname();
    const isOverlay = pathname.startsWith("/overlay/");
    const ownsBackground = pathname === "/stream/queue" || isOverlay;

    useEffect(() => {
        document.documentElement.classList.toggle("obsOverlayRoute", isOverlay);
        document.body.classList.toggle("obsOverlayRoute", isOverlay);

        return () => {
            document.documentElement.classList.remove("obsOverlayRoute");
            document.body.classList.remove("obsOverlayRoute");
        };
    }, [isOverlay]);

    if (ownsBackground) return null;

    return (
        <div className="appAtmosphere" aria-hidden="true">
            <div className={queueStyles.fallback} />
            <QueueTreeLayers />
            <RedFogBackground
                quality="medium"
                seed={123}
                forceFallback={false}
                onDebugStateChange={ignoreDebugState}
            />
            <div className={queueStyles.atmosphereFinish} />
        </div>
    );
};
