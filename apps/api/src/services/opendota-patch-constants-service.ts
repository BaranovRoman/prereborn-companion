import { openDotaMatchProvider, type DotaPatchConstant } from "./dota-match-provider.js";

// WK-148 - GET /constants/patch не привязан к account_id: это глобальный,
// вручную поддерживаемый (odota/dotaconstants) список патчей Dota, а не лента
// от Valve (см. задачу, секция 1). Кэшируем на весь бэкенд одной записью, а
// не на пользователя - обновление раз в сутки более чем достаточно для
// списка, который сам обновляется раз в несколько месяцев.
const PATCH_CONSTANTS_TTL_MS = 24 * 60 * 60_000;

interface CacheEntry {
    expiresAt: number;
    patches: DotaPatchConstant[];
}

let cache: CacheEntry | null = null;
let inFlight: Promise<DotaPatchConstant[]> | null = null;

// Единственный авторитетный источник "id патча -> человекочитаемое имя"
// (напр. 60 -> "7.41"). Ничего не резолвится в имя, если id отсутствует в
// этом списке - вызывающий код (patch resolution) обязан аккуратно
// откатываться, а не выдумывать номер (задача, секция 1, "обязательный
// fallback").
export const getCachedPatchConstants = async (): Promise<DotaPatchConstant[]> => {
    if (cache && cache.expiresAt > Date.now()) return cache.patches;
    if (inFlight) return inFlight;

    const request = openDotaMatchProvider
        .getPatchConstants()
        .then((result) => {
            const patches = result.status === "ok" ? result.patches : (cache?.patches ?? []);
            // Только успешный ответ продлевает TTL - на сбое отдаём последний
            // известный список (если есть) и позволяем следующему вызову
            // повторить попытку раньше, а не залипать на пустом списке.
            if (result.status === "ok") {
                cache = { patches, expiresAt: Date.now() + PATCH_CONSTANTS_TTL_MS };
            }
            return patches;
        })
        .finally(() => {
            inFlight = null;
        });

    inFlight = request;
    return request;
};

export const resolvePatchName = (patchId: number, patches: DotaPatchConstant[]): string | null =>
    patches.find((patch) => patch.id === patchId)?.name ?? null;

export const __resetOpenDotaPatchConstantsCacheForTests = (): void => {
    cache = null;
    inFlight = null;
};
