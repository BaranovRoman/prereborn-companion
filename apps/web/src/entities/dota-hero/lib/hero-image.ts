// Единственное место, откуда берётся URL иконки героя - Valve отдаёт их
// напрямую с собственного CDN (тот же источник, что использует сам сайт
// Dota 2), без ключа и без CORS-ограничений. Если источник когда-нибудь
// придётся сменить (свой прокси/кэш и т.п.) - меняется только эта функция,
// heroes.ts и всё остальное её не знают.
export const buildHeroImageUrl = (internalName: string): string =>
    `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/${internalName}.png`;
