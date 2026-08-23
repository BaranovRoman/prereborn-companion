import type { DraftProtectionTextSettings } from "@/entities/stream-overlay-layout/model/types";
import { AnchoredWidget, type AnchoredWidgetInteractive } from "../anchored-widget";
import { DraftSceneBackground } from "../draft-scene-background";
import { BouncingLogo } from "./bouncing-logo";
import { DraftProtectionText } from "./draft-protection-text";
import styles from "./full-cover-view.module.scss";

interface FullCoverViewProps {
    text?: DraftProtectionTextSettings;
    sceneWidth: number;
    sceneHeight: number;
    // Присутствует только в редакторе (см. AnchoredWidget) - на публичном
    // overlay текст рендерится статично, без drag.
    interactive?: AnchoredWidgetInteractive;
}

// "Заглушка" (внутренний mode-идентификатор остался "cover", см. types.ts) -
// простая безопасная заглушка, а не имитация picker'а: тот же атмосферный
// фон/шейдер, что и у остальных сцен драфта (см. DraftSceneBackground), плюс
// летающий логотип Prereborn. Никаких hero slots/silhouette/countdown -
// см. задачу WK-77 follow-up ("Полное перекрытие", позже переименовано в
// "Заглушка" в WK-69). Единственный текст, который здесь может появиться -
// статичный пользовательский текст из WK-86 (text.content), полностью
// независимый от летающего логотипа (BouncingLogo не читает layout вообще).
// Стример может свободно перекрыть эту сцену большой webcam как отдельным
// OBS source - рендерер её не учитывает и не пытается её избегать.
export const FullCoverView = ({ text, sceneWidth, sceneHeight, interactive }: FullCoverViewProps) => (
    <div className={styles.layer} data-testid="draft-protection-layer">
        <DraftSceneBackground seed={742} />
        <BouncingLogo />
        {text && text.content.trim().length > 0 && (
            <AnchoredWidget
                layout={text}
                sceneWidth={sceneWidth}
                sceneHeight={sceneHeight}
                interactive={interactive}
            >
                <DraftProtectionText content={text.content} />
            </AnchoredWidget>
        )}
    </div>
);
