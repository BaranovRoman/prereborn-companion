import type { OverlayCompanionState } from "@/entities/stream-session/model/types";
import { extractGsiSummary } from "./lib/extract-gsi-summary";
import { JsonTree } from "./json-tree";
import styles from "./debug-panel.module.scss";

interface DebugPanelProps {
    companion: OverlayCompanionState;
    scale?: number;
}

const formatTimestamp = (iso: string | null): string => {
    if (!iso) return "—";
    return new Date(iso).toLocaleTimeString("ru-RU", { hour12: false });
};

// Временная исследовательская debug-панель (см. задачу) - видна только с
// ?debug=1 (app/overlay/[publicToken]/page.tsx), никогда по умолчанию.
// payload сюда приходит уже санитизированным backend'ом
// (services/stream-companion-service.ts) - здесь его дополнительно никак
// не фильтруем, но и не доверяем его форме: extractGsiSummary/JsonTree сами
// по себе полностью защитны от отсутствующих полей.
export const DebugPanel = ({ companion, scale }: DebugPanelProps) => {
    const summary = extractGsiSummary(companion.payload);

    return (
        <div
            className={styles.panel}
            style={
                scale && scale !== 1
                    ? { transform: `scale(${scale})`, transformOrigin: "top left" }
                    : undefined
            }
        >
            <div className={styles.header}>
                <span className={styles.title}>DOTA GSI DEBUG</span>
                <span
                    className={
                        companion.isOnline ? styles.online : styles.offline
                    }
                >
                    ● {companion.isOnline ? "ONLINE" : "OFFLINE"}
                </span>
            </div>

            <div className={styles.timestamp}>
                Обновлено: {formatTimestamp(companion.receivedAt)}
                {companion.companionVersion && (
                    <span className={styles.version}>
                        {" "}
                        · companion v{companion.companionVersion}
                    </span>
                )}
            </div>

            {summary.length > 0 && (
                <div className={styles.summary}>
                    {summary.map((field) => (
                        <div key={field.label} className={styles.summaryRow}>
                            <span className={styles.summaryLabel}>
                                {field.label}
                            </span>
                            <span className={styles.summaryValue}>
                                {field.value}
                            </span>
                        </div>
                    ))}
                </div>
            )}

            <div className={styles.jsonWrapper}>
                {companion.payload ? (
                    <JsonTree value={companion.payload} />
                ) : (
                    <div className={styles.empty}>
                        Нет данных — companion ещё не присылал состояние.
                    </div>
                )}
            </div>
        </div>
    );
};
