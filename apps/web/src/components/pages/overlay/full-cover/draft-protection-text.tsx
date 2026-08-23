import styles from "./draft-protection-text.module.scss";

interface DraftProtectionTextProps {
    content: string;
}

// Свободный статичный текст на Draft Protected экране (см. задачу WK-86) -
// одна строка, serif, без rich text/анимаций. Позиционирование - через
// AnchoredWidget у вызывающей стороны (full-cover-view.tsx), этот компонент
// сам по себе не знает о layout.
export const DraftProtectionText = ({ content }: DraftProtectionTextProps) => (
    <div className={styles.text}>{content}</div>
);
