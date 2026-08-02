import type { OverlayAspectRatio } from "../model/types";

export interface SceneDimensions {
    width: number;
    height: number;
}

// Единственное место, где aspectRatio превращается в реальные px виртуальной
// сцены - ширина всегда OVERLAY_BASE_WIDTH (см. задачу), высота выводится из
// соотношения. Чистая функция без побочных эффектов - и OverlayCanvas, и
// страницы, которым нужны размеры сцены до измерения контейнера (редактор -
// для anchor/edge-padding математики, live overlay - для пропа AnchoredWidget),
// вызывают её независимо, а не тянут результат через контекст/render-prop.
export const computeSceneDimensions = (
    aspectRatio: OverlayAspectRatio
): SceneDimensions => ({
    width: aspectRatio.width,
    height: aspectRatio.height,
});
