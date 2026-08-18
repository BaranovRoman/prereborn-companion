// Единственные поля реального GSI-payload'а, которые сцены драфта разрешено
// читать: player.team_name и hero.id/hero.name - это уже используемые в
// проекте, документированные сообществом поля (см. api/src/__tests__/
// fixtures/gsi-payloads.ts, companion diagnostics/analysis.rs), которые и
// так проходят весь путь companion -> API -> overlay без изменений (см.
// docs/draft-gsi-contract.md). Пики/баны других игроков (draft.* секция)
// сюда намеренно не включены - у Valve нет стабильного документированного
// контракта на эти поля, см. контракт.
import { getHeroById } from "@/entities/dota-hero/lib/search";
import type { DotaHero } from "@/entities/dota-hero/model/types";

export type DraftTeamName = "radiant" | "dire";

export interface DraftSignals {
    teamName: DraftTeamName | null;
    hero: DotaHero | null;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
    typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;

const asPositiveInt = (value: unknown): number | null =>
    typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;

// Возвращает только то, что реально известно о собственном игроке: его
// команда и его собственный выбранный герой (если Dota уже сообщила hero.id
// к этому тику). Оба поля публичны для собственного стрима - это не чужой
// пик и не скрытая информация.
export const getDraftSignals = (payload: unknown): DraftSignals => {
    const root = asRecord(payload);
    const player = asRecord(root?.player);
    const heroSection = asRecord(root?.hero);

    const teamNameRaw = player?.team_name;
    const teamName: DraftTeamName | null =
        teamNameRaw === "radiant" || teamNameRaw === "dire" ? teamNameRaw : null;

    const heroId = asPositiveInt(heroSection?.id);
    const hero = heroId !== null ? getHeroById(heroId) ?? null : null;

    return { teamName, hero };
};
