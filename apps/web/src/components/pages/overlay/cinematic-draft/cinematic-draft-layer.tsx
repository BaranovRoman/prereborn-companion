import { AnimatePresence, motion } from "motion/react";
import { getDraftSignals } from "../lib/get-draft-signals";
import { HeroMedia } from "../hero-media";
import styles from "./cinematic-draft-layer.module.scss";

interface CinematicDraftLayerProps {
    payload: unknown;
}

const SLOTS_PER_TEAM = 5;

// "Real" cinematic draft для protection.mode === "off" - показывать реально
// нечего, кроме того, что уже безопасно и надёжно течёт через GSI: команда и
// герой самого стримера (см. get-draft-signals.ts и docs/draft-gsi-contract.md).
// GSI не даёt стабильного контракта на пики союзников/врагов, поэтому
// остальные 9 слотов остаются пустыми - это не баг, а часть композиции
// (см. задачу WK-77): сцена постепенно заполняется тем, что реально известно,
// а не имитирует данные, которых нет.
export const CinematicDraftLayer = ({ payload }: CinematicDraftLayerProps) => {
    const { teamName, hero } = getDraftSignals(payload);

    // Пока команда неизвестна - показываем обе стороны полностью пустыми,
    // не гадая, где окажется собственный герой.
    const ownRow: "top" | "bottom" = teamName === "dire" ? "bottom" : "top";

    const buildSlots = (row: "top" | "bottom") =>
        Array.from({ length: SLOTS_PER_TEAM }, (_, index) =>
            row === ownRow && index === 0 ? hero : null
        );

    const rows: Array<{ key: "top" | "bottom"; heroes: (ReturnType<typeof getDraftSignals>["hero"] | null)[] }> = [
        { key: "top", heroes: buildSlots("top") },
        { key: "bottom", heroes: buildSlots("bottom") },
    ];

    return (
        <div className={styles.layer} data-testid="cinematic-draft-layer">
            {rows.map((row) => (
                <div key={row.key} className={`${styles.row} ${styles[row.key]}`}>
                    {row.heroes.map((slotHero, index) => (
                        <div
                            key={slotHero?.id ?? `empty-${row.key}-${index}`}
                            className={styles.slot}
                            data-testid={`draft-slot-${row.key}-${index}`}
                        >
                            <AnimatePresence mode="wait">
                                {slotHero ? (
                                    <motion.div
                                        key={slotHero.id}
                                        className={styles.filled}
                                        initial={{ opacity: 0, scale: 0.92 }}
                                        animate={{ opacity: 1, scale: 1 }}
                                        exit={{ opacity: 0 }}
                                        transition={{ duration: 0.25 }}
                                    >
                                        <HeroMedia
                                            videoSrc={slotHero.videoUrl}
                                            imageSrc={slotHero.imageUrl}
                                            title={slotHero.localizedName}
                                        />
                                        <span className={styles.name}>{slotHero.localizedName}</span>
                                    </motion.div>
                                ) : (
                                    <motion.div
                                        key="empty"
                                        className={styles.empty}
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        exit={{ opacity: 0 }}
                                        transition={{ duration: 0.25 }}
                                    />
                                )}
                            </AnimatePresence>
                        </div>
                    ))}
                </div>
            ))}
        </div>
    );
};
