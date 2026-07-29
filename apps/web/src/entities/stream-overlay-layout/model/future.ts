// Типы для НЕреализованных пока фаз (game-UI reference, anti-streamsniping
// маски, draft/фазы игры) - см. задачу "подготовить архитектуру под игровые
// зоны и anti-streamsniping, но сами маски пока не реализовывать". Чисто
// типы, ничем не используются в рантайме этой фазы - вынесены в отдельный
// файл, чтобы не захламлять стабильный model/types.ts (тот описывает уже
// работающий layout).

// Фаза матча Dota, как её будет поставлять GSI/companion state в будущем
// (см. services/stream-companion-service.ts) - текущий код overlay не должен
// предполагать, что существует только "in-game" (см. задачу, п.11).
export type DotaGamePhase =
    | "draft"
    | "strategy"
    | "pre-game"
    | "in-game"
    | "post-game"
    | "unknown";

// Будущие независимые переключатели анти-стримснайпинга (см. задачу, п.12) -
// каждый флаг самостоятелен, никакой единой "Защита от стримснайпинга"
// кнопки, включающей всё разом.
export interface AntiSnipeSettings {
    enabled: boolean;

    hideDraftPicks: boolean;
    hideSelectedHeroDuringDraft: boolean;

    hideMinimap: boolean;
    hideBuybackStatus: boolean;
    hideGold: boolean;
    hideEnemyCooldownIndicators: boolean;
    hideAbilityCooldowns: boolean;

    // Ультимейт никогда не скрывается до 6 уровня (его физически не может
    // быть) - после 6 уровня чувствительным считается именно его cooldown
    // (сколько времени осталось до готовности), не сам факт наличия способности.
    hideUltimateCooldownAfterLevelSix: boolean;
}
