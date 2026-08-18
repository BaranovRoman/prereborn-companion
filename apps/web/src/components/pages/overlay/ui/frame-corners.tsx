import styles from "./frame-corners.module.scss";

// Декоративные металлические уголки рамки - общий примитив для showcase
// picker'а (fake-draft-picker) и full-cover (та же пространственная
// структура picker'а, см. full-cover-view.tsx). Чисто визуальный, без
// текста/данных - aria-hidden.
export const FrameCorners = () => (
    <span className={styles.corners} aria-hidden="true">
        <span className={`${styles.corner} ${styles.tl}`} />
        <span className={`${styles.corner} ${styles.tr}`} />
        <span className={`${styles.corner} ${styles.bl}`} />
        <span className={`${styles.corner} ${styles.br}`} />
    </span>
);
