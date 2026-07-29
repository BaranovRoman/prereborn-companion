export interface GsiSummaryField {
    label: string;
    value: string;
}

const asObject = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;

// Единственная точка принятия решения "показывать это поле или нет" -
// только string/number/boolean, только непустая строка. Всё остальное
// (undefined, null, объект, массив) молча пропускается: GSI-структура не
// документирована формально Valve и может отличаться от матча к матчу,
// поэтому падать или показывать "undefined" здесь недопустимо (см. задачу,
// п.5A).
const addField = (
    fields: GsiSummaryField[],
    label: string,
    value: unknown
): void => {
    if (typeof value === "string" && value.length > 0) {
        fields.push({ label, value });
    } else if (typeof value === "number" && Number.isFinite(value)) {
        fields.push({ label, value: String(value) });
    } else if (typeof value === "boolean") {
        fields.push({ label, value: value ? "да" : "нет" });
    }
};

// Извлекает набор общеизвестных полей стандартного Dota 2 GSI-протокола из
// произвольного payload. Список полей - из задачи (п.5A): не исчерпывающая
// схема, а "лучшие усилия" - полное дерево ниже (JsonTree) всё равно
// показывает абсолютно всё, эта сводка - только удобный быстрый обзор.
export const extractGsiSummary = (payload: unknown): GsiSummaryField[] => {
    const root = asObject(payload);
    if (!root) return [];

    const fields: GsiSummaryField[] = [];

    const provider = asObject(root.provider);
    addField(fields, "Provider", provider?.name);
    addField(fields, "GSI version", provider?.version);

    const map = asObject(root.map);
    addField(fields, "Game state", map?.game_state);
    addField(fields, "Match ID", map?.matchid);
    addField(fields, "Clock", map?.clock_time);
    addField(fields, "Radiant score", map?.radiant_score);
    addField(fields, "Dire score", map?.dire_score);
    addField(fields, "Win team", map?.win_team);

    const player = asObject(root.player);
    addField(fields, "Player", player?.name);
    addField(fields, "SteamID", player?.steamid);
    addField(fields, "Team", player?.team_name);
    addField(fields, "Activity", player?.activity);
    addField(fields, "Kills", player?.kills);
    addField(fields, "Deaths", player?.deaths);
    addField(fields, "Assists", player?.assists);
    addField(fields, "Last hits", player?.last_hits);
    addField(fields, "Denies", player?.denies);
    addField(fields, "Gold", player?.gold);
    addField(fields, "GPM", player?.gpm);
    addField(fields, "XPM", player?.xpm);

    const hero = asObject(root.hero);
    addField(fields, "Hero", hero?.name);
    addField(fields, "Hero level", hero?.level);
    addField(fields, "Alive", hero?.alive);
    addField(fields, "Health", hero?.health);
    addField(fields, "Max health", hero?.max_health);
    addField(fields, "Mana", hero?.mana);
    addField(fields, "Max mana", hero?.max_mana);

    return fields;
};
