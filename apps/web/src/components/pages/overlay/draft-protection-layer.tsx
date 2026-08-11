import type { DraftProtectionMode } from "@/entities/stream-overlay-layout/model/types";
import styles from "./draft-protection-layer.module.scss";

interface DraftProtectionLayerProps {
    mode: DraftProtectionMode;
}

const PUBLIC_PICKS = [
    "Crystal Maiden",
    "Juggernaut",
    "Earthshaker",
    "Drow Ranger",
    "Invoker",
    "Axe",
    "Lina",
    "Bane",
    "Bloodseeker",
    "Anti-Mage",
];

export const DraftProtectionLayer = ({ mode }: DraftProtectionLayerProps) => {
    if (mode === "off") return null;

    return (
        <div className={styles.layer} data-testid="draft-protection-layer">
            {mode === "cover" ? (
                <div className={styles.cover}>
                    <span className={styles.eyebrow}>DRAFT PROTECTED</span>
                    <strong>Выбор героев скрыт</strong>
                    <span>Трансляция продолжится после завершения драфта</span>
                </div>
            ) : (
                <div className={styles.publicDraft}>
                    <div className={styles.heading}>
                        <span>PUBLIC DRAFT</span>
                        <strong>Безопасная версия для трансляции</strong>
                    </div>
                    <div className={styles.teams}>
                        {["Radiant", "Dire"].map((team, teamIndex) => (
                            <section key={team}>
                                <h2>{team}</h2>
                                <div className={styles.picks}>
                                    {PUBLIC_PICKS.slice(teamIndex * 5, teamIndex * 5 + 5).map(
                                        (hero, index) => (
                                            <div className={styles.pick} key={hero}>
                                                <span>{String(index + 1).padStart(2, "0")}</span>
                                                <strong>{hero}</strong>
                                            </div>
                                        )
                                    )}
                                </div>
                            </section>
                        ))}
                    </div>
                    <p>Публичная композиция не связана с реальными пиками и банами.</p>
                </div>
            )}
        </div>
    );
};