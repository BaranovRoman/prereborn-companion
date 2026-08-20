import type { ReactNode } from "react";
import type { DraftProtectionMode } from "@/entities/stream-overlay-layout/model/types";
import { FullCoverView } from "./full-cover/full-cover-view";

interface DraftProtectionLayerProps {
    mode: DraftProtectionMode;
}

// Registry keyed off DraftProtectionMode instead of an `off ? : cover`
// ternary - Record<DraftProtectionMode, ...> forces every entry of the union
// to have a renderer, so adding a mode to DRAFT_PROTECTION_MODES (types.ts)
// is a compile error here until this map is extended too, rather than
// silently falling through to a default case.
//
// WK-69 follow-up (visual review): "off" used to render a real GSI-driven
// draft grid (Cinematic Draft) and "substitute" a fake hero carousel (Fake
// Draft) - both removed. "off" is now a literal no-op: it must draw nothing
// over the real Dota UI, and must never substitute fake data for what it
// used to show.
const RENDERERS: Record<DraftProtectionMode, () => ReactNode> = {
    off: () => null,
    cover: () => <FullCoverView />,
};

export const DraftProtectionLayer = ({ mode }: DraftProtectionLayerProps) => RENDERERS[mode]();
