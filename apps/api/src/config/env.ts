import dotenv from "dotenv";

dotenv.config();

// Отдельный секрет для сервиса стрим-оверлеев (/api/stream/*) - эта система
// пользователей полностью изолирована от админки: свой JWT_SECRET гарантирует,
// что access-токен одной системы физически не может быть принят middleware
// другой, даже если формат payload случайно совпадёт.
const streamJwtSecret = process.env.STREAM_JWT_SECRET;

if (!streamJwtSecret) {
    throw new Error(
        "STREAM_JWT_SECRET is required. Set it in the environment (.env) before starting the server."
    );
}

// Steam OpenID / OpenDota - опциональны на уровне процесса (в отличие от
// JWT_SECRET), намеренно НЕ валятся при старте: без них ломается только
// привязка Steam (controllers/stream/steam.ts сам вернёт понятную ошибку
// "интеграция не настроена"), а не весь сайт/бэкенд. STEAM_OPENID_REALM
// используется дважды - как openid.realm в самом OpenID-запросе И как база
// для редиректа обратно на фронтенд после callback (тот же публичный домен
// в этом проекте обслуживает и сайт, и API через один nginx, см.
// nginx.production.conf) - заводить отдельную переменную под второе не нужно.
const steamOpenidRealm = process.env.STEAM_OPENID_REALM || null;
const steamOpenidReturnUrl = process.env.STEAM_OPENID_RETURN_URL || null;
// OpenDota не требует ключ для базового использования (60 запросов/мин,
// 3000/день на бесплатном тарифе - см. GET /api/metadata, поле freeRateLimit/
// freeCallLimit) - более чем достаточно с серверным cooldown на пользователя
// (services/dota-sync-service.ts). Ключ добавлен только чтобы поднять лимит
// в будущем, если понадобится - без него всё работает.
const openDotaApiKey = process.env.OPENDOTA_API_KEY || null;

const nodeEnv = process.env.NODE_ENV || "development";
const isProduction = nodeEnv === "production";
const isTest = nodeEnv === "test";

const parseIntEnv = (value: string | undefined, fallback: number): number => {
    const parsed = parseInt(value ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseOrigins = (value: string | undefined): string[] =>
    (value ?? "")
        .split(",")
        .map((origin) => origin.trim().replace(/\/+$/, ""))
        .filter(Boolean);

// В production сюда должны попадать реальные домены фронтенда и админки
// (например https://baranov-digital.ru). Локальные origin разработки
// разрешаются отдельно и только вне production, см. src/config/cors.ts.
const corsAllowedOrigins = parseOrigins(process.env.CORS_ALLOWED_ORIGINS);

export const env = {
    streamJwtSecret,
    steamOpenidRealm,
    steamOpenidReturnUrl,
    openDotaApiKey,
    port: parseInt(process.env.PORT || "5002", 10),
    nodeEnv,
    isProduction,
    isTest,
    corsAllowedOrigins,
    logLevel: process.env.LOG_LEVEL || (isProduction ? "info" : "debug"),
    loginRateLimit: {
        windowMs: parseIntEnv(
            process.env.LOGIN_RATE_LIMIT_WINDOW_MS,
            isTest ? 1000 : 15 * 60 * 1000
        ),
        max: parseIntEnv(process.env.LOGIN_RATE_LIMIT_MAX, isTest ? 5 : 10),
    },
    // Отдельный бакет от loginRateLimit - независимая система пользователей,
    // не должна делить счётчик попыток с админкой.
    streamAuthRateLimit: {
        windowMs: parseIntEnv(
            process.env.STREAM_AUTH_RATE_LIMIT_WINDOW_MS,
            isTest ? 1000 : 15 * 60 * 1000
        ),
        max: parseIntEnv(
            process.env.STREAM_AUTH_RATE_LIMIT_MAX,
            isTest ? 5 : 10
        ),
    },
    // Публичный callback Steam OpenID - без авторизации, защита по IP как у
    // contactRateLimit/solitaireRateLimit. Реальная защита от подделки -
    // проверка подписи + одноразовый state (services/steam-openid-service.ts,
    // services/steam-connect-state-service.ts), это ограничение - просто от
    // бессмысленного долбления эндпоинта.
    steamCallbackRateLimit: {
        windowMs: parseIntEnv(
            process.env.STEAM_CALLBACK_RATE_LIMIT_WINDOW_MS,
            isTest ? 1000 : 15 * 60 * 1000
        ),
        max: parseIntEnv(
            process.env.STEAM_CALLBACK_RATE_LIMIT_MAX,
            isTest ? 5 : 20
        ),
    },
    uploadRateLimit: {
        windowMs: parseIntEnv(
            process.env.UPLOAD_RATE_LIMIT_WINDOW_MS,
            isTest ? 1000 : 60 * 1000
        ),
        max: parseIntEnv(process.env.UPLOAD_RATE_LIMIT_MAX, isTest ? 20 : 30),
    },
    contactRateLimit: {
        windowMs: parseIntEnv(
            process.env.CONTACT_RATE_LIMIT_WINDOW_MS,
            isTest ? 1000 : 15 * 60 * 1000
        ),
        max: parseIntEnv(process.env.CONTACT_RATE_LIMIT_MAX, isTest ? 5 : 5),
    },
    // Публичный POST без авторизации (как contactRateLimit) - лимит мягче,
    // чем у формы "Связаться": обычная игровая сессия может дать несколько
    // побед подряд. В development лимит намного выше: dev-панель
    // (solitaire-debug-panel.tsx) сама по себе шлёт пачками до 10+ запросов
    // за один клик ("Заполнить TOP 10"), production-лимит 20/15мин её бы
    // душил после одного-двух прогонов сценариев.
    solitaireRateLimit: {
        windowMs: parseIntEnv(
            process.env.SOLITAIRE_RATE_LIMIT_WINDOW_MS,
            isTest ? 1000 : 15 * 60 * 1000
        ),
        max: parseIntEnv(
            process.env.SOLITAIRE_RATE_LIMIT_MAX,
            isTest ? 10 : isProduction ? 20 : 200
        ),
    },
    // Companion (apps/dota-companion) сам троттлит себя до ~1 запроса/сек
    // (см. отчёт по фиче) - этот лимитер чисто defense-in-depth на случай
    // скомпрометированного/сломанного клиента, поэтому лимит заметно щедрее,
    // чем у стандартного троттлинга companion.
    streamCompanionRateLimit: {
        windowMs: parseIntEnv(
            process.env.STREAM_COMPANION_RATE_LIMIT_WINDOW_MS,
            isTest ? 1000 : 10 * 1000
        ),
        max: parseIntEnv(
            process.env.STREAM_COMPANION_RATE_LIMIT_MAX,
            isTest ? 20 : 20
        ),
    },
    // Единственный источник правды для лимита размера видео - используется
    // и в multer.limits.fileSize (controllers/upload-video.ts), и в тексте
    // ошибки LIMIT_FILE_SIZE (middleware/error-handler.ts). nginx не умеет
    // читать .env без доп. шаблонизации, поэтому client_max_body_size в
    // nginx.production.conf задаётся отдельным явным числом (с запасом) -
    // при изменении этого значения синхронизируйте оба места вручную, см.
    // комментарий в nginx.production.conf.
    maxVideoUploadSizeMb: parseIntEnv(
        process.env.MAX_VIDEO_UPLOAD_SIZE_MB,
        500
    ),
};
