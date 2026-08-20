import { DraftSceneBackground } from "../draft-scene-background";
import { BouncingLogo } from "./bouncing-logo";
import styles from "./full-cover-view.module.scss";

// "Заглушка" (внутренний mode-идентификатор остался "cover", см. types.ts) -
// простая безопасная заглушка, а не имитация picker'а: тот же атмосферный
// фон/шейдер, что и у остальных сцен драфта (см. DraftSceneBackground), плюс
// летающий логотип Prereborn. Никаких hero slots/silhouette/countdown/
// статусных текстов - см. задачу WK-77 follow-up ("Полное перекрытие", позже
// переименовано в "Заглушка" в WK-69). Стример может свободно перекрыть эту
// сцену большой webcam как отдельным OBS source - рендерер её не учитывает
// и не пытается её избегать.
export const FullCoverView = () => (
    <div className={styles.layer} data-testid="draft-protection-layer">
        <DraftSceneBackground seed={742} />
        <BouncingLogo />
    </div>
);
