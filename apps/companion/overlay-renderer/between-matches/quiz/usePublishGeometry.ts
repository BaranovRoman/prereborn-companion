import { useEffect } from "react";
import type { RefObject } from "react";

// WK-116 Phase 3 - Companion is the sole geometry producer (locked
// architecture decision: web fallback must NOT publish geometry). Measures
// the real rendered answer-button DOM rects, normalized against the scene
// root (the full video canvas, per the Phase 0 placement review), and POSTs
// them to the LOCAL overlay server's `/overlay/quiz-geometry` (same origin
// as this page - never cross-origin, see overlay_server.rs's handler doc
// comment), which Rust then forwards to the authenticated backend endpoint.
// This is a best-effort report: a dropped request just means the Extension
// keeps whatever geometry it last received (or fails closed if it never got
// any - see the Phase 4 fail-closed requirement), not something this hook
// needs to retry synchronously.
export function usePublishGeometry(
    sceneRef: RefObject<HTMLElement | null>,
    roundId: string | undefined,
    phase: "question" | "reveal" | undefined
) {
    useEffect(() => {
        if (!roundId) return;
        const root = sceneRef.current;
        if (!root) return;

        const measureAndPublish = () => {
            const rootRect = root.getBoundingClientRect();
            if (rootRect.width === 0 || rootRect.height === 0) return;
            const buttons = Array.from(root.querySelectorAll<HTMLElement>("[data-quiz-option-id]"));
            if (buttons.length === 0) return;
            const interactiveRegions = buttons.map((button) => {
                const rect = button.getBoundingClientRect();
                return {
                    id: button.dataset.quizOptionId ?? "",
                    x: (rect.left - rootRect.left) / rootRect.width,
                    y: (rect.top - rootRect.top) / rootRect.height,
                    width: rect.width / rootRect.width,
                    height: rect.height / rootRect.height,
                    value: button.dataset.quizOptionId ?? "",
                };
            });
            fetch("/overlay/quiz-geometry", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ roundId, interactiveRegions }),
            }).catch(() => {
                // Best-effort, see doc comment above.
            });
        };

        // rAF, not an immediate synchronous measurement - lets this round's
        // buttons actually paint first (a fresh round swaps the question/
        // option labels, which can reflow button widths).
        const raf = requestAnimationFrame(measureAndPublish);
        const observer = new ResizeObserver(measureAndPublish);
        observer.observe(root);
        return () => {
            cancelAnimationFrame(raf);
            observer.disconnect();
        };
    }, [sceneRef, roundId, phase]);
}
