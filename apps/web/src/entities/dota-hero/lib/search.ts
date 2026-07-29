import { DOTA_HEROES } from "../model/heroes";
import type { DotaHero } from "../model/types";

export const getHeroById = (id: number): DotaHero | undefined =>
    DOTA_HEROES.find((hero) => hero.id === id);

// Поиск по обоим именам - внутреннему (name, "windrunner") и
// отображаемому (localizedName, "Windranger") - стример может помнить
// героя по любому из них.
export const searchHeroes = (query: string): DotaHero[] => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return DOTA_HEROES;

    return DOTA_HEROES.filter(
        (hero) =>
            hero.name.toLowerCase().includes(normalized) ||
            hero.localizedName.toLowerCase().includes(normalized)
    );
};
