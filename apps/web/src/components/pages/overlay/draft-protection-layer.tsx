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

export const DraftProtectionLayer = ({ mode, payload }: DraftProtectionLayerProps) => {
    if (mode === "off") return <CinematicDraftLayer payload={payload} />;

    if (mode === "substitute") return <FakeDraftPicker payload={payload} />;

    return <FullCoverView />;
};
