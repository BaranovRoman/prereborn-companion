"use client";

import { useRef, type PointerEvent } from "react";
import type { CameraZone } from "@/entities/stream-overlay-layout/model/types";
import { anchorFraction } from "@/entities/stream-overlay-layout/lib/anchor";
import styles from "./index.module.scss";

interface CameraZoneEditorProps {
    zone: CameraZone;
    sceneScale: number;
    sceneWidth: number;
    sceneHeight: number;
    onChange: (patch: Partial<CameraZone>) => void;
}

type Gesture = {
    mode: "move" | "resize";
    pointerId: number;
    clientX: number;
    clientY: number;
    zone: CameraZone;
};

const clamp = (value: number, min: number, max: number) =>
    Math.min(Math.max(value, min), max);

export const CameraZoneEditor = ({
    zone,
    sceneScale,
    sceneWidth,
    sceneHeight,
    onChange,
}: CameraZoneEditorProps) => {
    const gesture = useRef<Gesture | null>(null);
    const fraction = anchorFraction(zone.anchor);
    const anchoredLeft = zone.x - fraction.x * zone.width;
    const anchoredTop = zone.y - fraction.y * zone.height;

    const start = (
        event: PointerEvent<HTMLDivElement>,
        mode: Gesture["mode"]
    ) => {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        gesture.current = {
            mode,
            pointerId: event.pointerId,
            clientX: event.clientX,
            clientY: event.clientY,
            zone,
        };
    };

    const move = (event: PointerEvent<HTMLDivElement>) => {
        const active = gesture.current;
        if (!active || active.pointerId !== event.pointerId) return;
        const dx = (event.clientX - active.clientX) / sceneScale;
        const dy = (event.clientY - active.clientY) / sceneScale;

        if (active.mode === "move") {
            onChange({
                x: Math.round(clamp(active.zone.x + dx, 0, sceneWidth)),
                y: Math.round(clamp(active.zone.y + dy, 0, sceneHeight)),
            });
            return;
        }

        onChange({
            width: Math.round(
                clamp(active.zone.width + dx, 80, sceneWidth)
            ),
            height: Math.round(
                clamp(active.zone.height + dy, 80, sceneHeight)
            ),
        });
    };

    const end = (event: PointerEvent<HTMLDivElement>) => {
        if (gesture.current?.pointerId === event.pointerId) gesture.current = null;
    };

    return (
        <div
            className={styles.cameraZone}
            style={{
                left: anchoredLeft,
                top: anchoredTop,
                width: zone.width,
                height: zone.height,
            }}
            onPointerDown={(event) => start(event, "move")}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
        >
            <span>Камера в OBS</span>
            <small>
                {Math.round(zone.x)}, {Math.round(zone.y)} · {Math.round(zone.width)} ×{" "}
                {Math.round(zone.height)} px
            </small>
            <div
                className={styles.cameraResizeHandle}
                onPointerDown={(event) => start(event, "resize")}
                onPointerMove={move}
                onPointerUp={end}
                onPointerCancel={end}
                aria-label="Изменить размер области камеры"
            />
        </div>
    );
};
