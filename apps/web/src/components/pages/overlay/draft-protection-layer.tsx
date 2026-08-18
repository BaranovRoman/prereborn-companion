import type { ReactNode } from "react";
import type { DraftProtectionMode } from "@/entities/stream-overlay-layout/model/types";
import { CinematicDraftLayer } from "./cinematic-draft/cinematic-draft-layer";
import { FakeDraftPicker } from "./fake-draft-picker/fake-draft-picker";
import { FullCoverView } from "./full-cover/full-cover-view";

interface DraftProtectionLayerProps {
    mode: DraftProtectionMode;
    // Единственный вход реального GSI-payload'а в сцены драфта - "off"
    // читает из него собственную команду/героя (see get-draft-signals.ts),
    // "substitute" читает из него только то же самое, чтобы НИКОГДА не
    // показать это как fake pick. "cover" его не использует вовсе.
    payload?: unknown;
}

// Registry keyed off DraftProtectionMode instead of an `off ? : substitute ?
// : cover` ternary chain - Record<DraftProtectionMode, ...> forces every
// entry of the union to have a renderer, so adding a mode to
// DRAFT_PROTECTION_MODES (types.ts) is a compile error here until this map
// is extended too, rather than silently falling through to a default case.
const RENDERERS: Record<DraftProtectionMode, (payload: unknown) => ReactNode> = {
    off: (payload) => <CinematicDraftLayer payload={payload} />,
    substitute: (payload) => <FakeDraftPicker payload={payload} />,
    cover: () => <FullCoverView />,
};

export const DraftProtectionLayer = ({ mode, payload }: DraftProtectionLayerProps) =>
    RENDERERS[mode](payload);
