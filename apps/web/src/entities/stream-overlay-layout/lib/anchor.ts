import type { OverlayAnchor } from "../model/types";

export type AnchorAxisX = "left" | "center" | "right";
export type AnchorAxisY = "top" | "center" | "bottom";

const AXIS_X_FRACTION: Record<AnchorAxisX, number> = {
    left: 0,
    center: 0.5,
    right: 1,
};

const AXIS_Y_FRACTION: Record<AnchorAxisY, number> = {
    top: 0,
    center: 0.5,
    bottom: 1,
};

// Разбирает "bottom-right" -> {x:"right", y:"bottom"}, "center" ->
// {x:"center", y:"center"}, "center-left" -> {x:"left", y:"center"}. Все 9
// значений OverlayAnchor следуют схеме "{y}-{x}" (или просто "center" когда
// обе оси центр) - см. OVERLAY_ANCHORS.
export const splitAnchor = (
    anchor: OverlayAnchor
): { x: AnchorAxisX; y: AnchorAxisY } => {
    if (anchor === "center") return { x: "center", y: "center" };
    const [y, x] = anchor.split("-") as [AnchorAxisY, AnchorAxisX];
    return { x, y };
};

export const combineAnchor = (
    x: AnchorAxisX,
    y: AnchorAxisY
): OverlayAnchor => {
    if (x === "center" && y === "center") return "center";
    if (y === "center") return `center-${x}` as OverlayAnchor;
    return `${y}-${x}` as OverlayAnchor;
};

// Доля виджета (0-1 по каждой оси), которая должна сидеть ровно в точке
// (xVw, yVh) - "top-left" => (0,0) - левый верхний угол виджета в точке;
// "bottom-right" => (1,1) - его правый нижний угол; "center" => (0.5,0.5).
export const anchorFraction = (
    anchor: OverlayAnchor
): { x: number; y: number } => {
    const { x, y } = splitAnchor(anchor);
    return { x: AXIS_X_FRACTION[x], y: AXIS_Y_FRACTION[y] };
};
