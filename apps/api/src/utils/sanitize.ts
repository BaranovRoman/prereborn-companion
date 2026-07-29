import sanitizeHtml from "sanitize-html";

/**
 * Поля из CMS (case_blocks.content, effect_tags.name) рендерятся на фронте
 * через dangerouslySetInnerHTML, но в админке заполняются обычными
 * текстовыми полями без rich-text редактора. Легитимной необходимости
 * в HTML-тегах нет, поэтому все теги вырезаются, остаётся только текст.
 */
export const stripHtml = (value: string): string =>
    sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} });
