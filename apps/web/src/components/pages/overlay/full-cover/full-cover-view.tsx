import { DraftSceneBackground } from "../draft-scene-background";
import styles from "./full-cover-view.module.scss";

const PLACEHOLDER_CARD_COUNT = 11;

// Полное перекрытие - та же shader-подложка и та же пространственная
// структура picker'а (showcase + carousel), что и у Public Draft
// (fake-draft-picker.tsx), но без единого реального или fake кадра: центр -
// silhouette-заглушка, карусель - скрытые placeholder-карточки. Никаких
// timer/filters/actions - это не "picking" состояние, а сознательно скрытое.
export const FullCoverView = () => (
    <div className={styles.layer} data-testid="draft-protection-layer">
        <DraftSceneBackground seed={742} />

        <div className={styles.picker}>
            <div className={styles.showcase}>
                <div className={styles.silhouette} aria-hidden="true" />
                <div className={styles.statusCaption}>
                    <span className={styles.eyebrow}>DRAFT PROTECTED</span>
                    <strong>Информация скрыта во время драфта</strong>
                </div>
            </div>

            <div className={styles.carouselRow}>
                {Array.from({ length: PLACEHOLDER_CARD_COUNT }, (_, index) => (
                    <div
                        key={index}
                        className={`${styles.card} ${index === Math.floor(PLACEHOLDER_CARD_COUNT / 2) ? styles.cardCenter : ""}`}
                        data-testid={`cover-placeholder-card-${index}`}
                    />
                ))}
            </div>
        </div>
    </div>
);
