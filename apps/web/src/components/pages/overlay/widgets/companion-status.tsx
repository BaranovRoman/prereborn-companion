import type { OverlayCompanionState } from "@/entities/stream-session/model/types";
import styles from "./widget.module.scss";

interface CompanionStatusProps {
    companion: OverlayCompanionState;
}

// Раньше индикатор "companion online/offline" был виден только в
// ?debug=1-панели - теперь это полноценный виджет HUD (можно скрыть через
// редактор раскладки, но по умолчанию показывается).
export const CompanionStatus = ({ companion }: CompanionStatusProps) => {
    return (
        <div className={styles.card}>
            <div className={styles.companion}>
                <span
                    className={`${styles.companionDot} ${
                        companion.isOnline
                            ? styles.companionOnline
                            : styles.companionOffline
                    }`}
                >
                    ●
                </span>
                Companion {companion.isOnline ? "online" : "offline"}
            </div>
        </div>
    );
};
