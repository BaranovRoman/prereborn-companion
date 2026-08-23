import dotenv from "dotenv";
import path from "path";

dotenv.config();

// WK-80 - explicit, absolute, version-independent uploads location. Must
// NOT be derived from process.cwd(): once production runs the API from a
// versioned `releases/<sha>/api` directory behind a `current` symlink,
// process.cwd() resolves to that release's own directory (physical path,
// not the symlink), which would silently scope user-uploaded files to one
// release and orphan them on every switch. UPLOADS_DIR points at a fixed,
// non-versioned location instead (see docs/production-deployment.md); falls
// back to cwd-relative "uploads" for local dev, where there is no release
// directory at all.
const uploadsDir = process.env.UPLOADS_DIR
    ? path.resolve(process.env.UPLOADS_DIR)
    : path.join(process.cwd(), "uploads");

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

// db/client.ts falls back to a local-dev connection (host/user/password
// default to localhost/postgres/postgres) when DATABASE_URL is unset, which
// would otherwise let a misconfigured production process start up and quietly
// point at the wrong database instead of failing loudly at boot.
if (!process.env.DATABASE_URL) {
    throw new Error(
        "DATABASE_URL is required. Set it in the environment (.env) before starting the server."
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
const twitchClientId = process.env.TWITCH_CLIENT_ID || null;
const twitchClientSecret = process.env.TWITCH_CLIENT_SECRET || null;
const twitchRedirectUri = process.env.TWITCH_REDIRECT_URI || null;
const twitchFrontendOrigin = process.env.TWITCH_FRONTEND_ORIGIN || steamOpenidRealm;
const donationAlertsClientId = process.env.DONATION_ALERTS_CLIENT_ID || null;
const donationAlertsClientSecret = process.env.DONATION_ALERTS_CLIENT_SECRET || null;
const donationAlertsRedirectUri = process.env.DONATION_ALERTS_REDIRECT_URI || null;
const donationAlertsFrontendOrigin = process.env.DONATION_ALERTS_FRONTEND_ORIGIN || steamOpenidRealm;

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
// Production origins are supplied explicitly. Локальные origin разработки
// разрешаются отдельно и только вне production, см. src/config/cors.ts.
const corsAllowedOrigins = parseOrigins(process.env.CORS_ALLOWED_ORIGINS);

// Минимальный admin-примитив (WK-52): нет отдельной системы ролей, поэтому
// администратор - это существующий stream-пользователь (тот же JWT из
// authenticateStreamUser), чей email входит в этот allowlist. Проверяется
// только на бэкенде (middleware/require-admin.ts) - пустой список означает
// "admin-панель недоступна никому", а не "всем".
const adminEmails = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

// WK-88 follow-up (production regression) - not secret: the commit SHA a
// production release was built from. Set by release.sh via PM2's env (see
// ecosystem.config.cjs), read back through /api/health so the deploy
// pipeline can verify the *running* process actually matches the release
// `current` was just switched to, instead of only checking "a process is
// listening on the port" (which is exactly what let this regression through
// undetected - see release.sh's health_check()).
const releaseSha = process.env.PREREBORN_RELEASE_SHA || null;

export const env = {
    streamJwtSecret,
    uploadsDir,
    releaseSha,
    steamOpenidRealm,
    steamOpenidReturnUrl,
    openDotaApiKey,
    twitchClientId,
    twitchClientSecret,
    twitchRedirectUri,
    twitchFrontendOrigin,
    donationAlertsClientId,
    donationAlertsClientSecret,
    donationAlertsRedirectUri,
    donationAlertsFrontendOrigin,
    port: parseInt(process.env.PORT || "3001", 10),
    nodeEnv,
    isProduction,
    isTest,
    corsAllowedOrigins,
    adminEmails,
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
