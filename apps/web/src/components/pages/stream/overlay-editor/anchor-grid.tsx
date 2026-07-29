import { Tooltip } from "antd";
import type { OverlayAnchor } from "@/entities/stream-overlay-layout/model/types";
import {
    combineAnchor,
    type AnchorAxisX,
    type AnchorAxisY,
} from "@/entities/stream-overlay-layout/lib/anchor";
import styles from "./anchor-grid.module.scss";

interface AnchorGridProps {
    value: OverlayAnchor;
    onChange: (anchor: OverlayAnchor) => void;
}

const ROWS: AnchorAxisY[] = ["top", "center", "bottom"];
const COLS: AnchorAxisX[] = ["left", "center", "right"];

const LABELS: Record<OverlayAnchor, string> = {
    "top-left": "Слева сверху",
    "top-center": "По центру сверху",
    "top-right": "Справа сверху",
    "center-left": "Слева по центру",
    center: "По центру",
    "center-right": "Справа по центру",
    "bottom-left": "Слева снизу",
    "bottom-center": "По центру снизу",
    "bottom-right": "Справа снизу",
};

// Явный выбор точки привязки виджета - сетка 3x3 (см. задачу, п.6). Anchor
// меняется ТОЛЬКО здесь (явное действие) или автоматически при явном
// snapping виджета к внешней границе сцены во время drag (см.
// anchored-widget.tsx) - выбрано именно это сочетание как самое
// предсказуемое: обычный drag внутри сцены никогда не подменяет anchor
// незаметно, а сетка даёт полный ручной контроль в любой момент.
export const AnchorGrid = ({ value, onChange }: AnchorGridProps) => {
    return (
        <div className={styles.grid}>
            {ROWS.map((y) =>
                COLS.map((x) => {
                    const anchor = combineAnchor(x, y);
                    const isActive = anchor === value;
                    return (
                        <Tooltip key={anchor} title={LABELS[anchor]}>
                            <button
                                type="button"
                                className={`${styles.cell} ${
                                    isActive ? styles.cellActive : ""
                                }`}
                                onClick={() => onChange(anchor)}
                                aria-label={LABELS[anchor]}
                                aria-pressed={isActive}
                            >
                                <span
                                    className={`${styles.dot} ${
                                        isActive ? styles.dotActive : ""
                                    }`}
                                />
                            </button>
                        </Tooltip>
                    );
                })
            )}
        </div>
    );
};
