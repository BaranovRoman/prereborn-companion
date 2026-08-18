import type { DraftProtectionMode } from "@/entities/stream-overlay-layout/model/types";
import { CinematicDraftLayer } from "./cinematic-draft/cinematic-draft-layer";
import { FakeDraftPicker } from "./fake-draft-picker/fake-draft-picker";
import styles from "./draft-protection-layer.module.scss";

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

    return (
        <div className={styles.layer} data-testid="draft-protection-layer">
            <div className={styles.cover}>
                <span className={styles.eyebrow}>DRAFT PROTECTED</span>
                <strong>Выбор героев скрыт</strong>
                <span>Трансляция продолжится после завершения драфта</span>
            </div>
        </div>
    );
};