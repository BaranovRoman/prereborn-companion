import rateLimit from "express-rate-limit";
import { Request, Response } from "express";
import { env } from "../config/env.js";

const rateLimitedResponse = (code: string, message: string) => (
    req: Request,
    res: Response
) => {
    res.status(429).json({
        error: message,
        code,
        requestId: req.requestId,
    });
};

// Строгий лимитер для логина: считает попытки по IP, не сбрасывается успешным
// входом (skipSuccessfulRequests не включён), чтобы нельзя было обойти перебор
// чередованием верных/неверных паролей.
export const loginRateLimiter = rateLimit({
    windowMs: env.loginRateLimit.windowMs,
    limit: env.loginRateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitedResponse(
        "TOO_MANY_LOGIN_ATTEMPTS",
        "Слишком много попыток входа. Попробуйте позже."
    ),
});

// Лимитер для /api/stream/auth/register и /login - отдельный бакет от
// loginRateLimiter (независимая система пользователей), тот же принцип:
// считает попытки по IP, не сбрасывается успешным запросом.
export const streamAuthRateLimiter = rateLimit({
    windowMs: env.streamAuthRateLimit.windowMs,
    limit: env.streamAuthRateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitedResponse(
        "TOO_MANY_STREAM_AUTH_ATTEMPTS",
        "Слишком много попыток. Попробуйте позже."
    ),
});

// Более мягкий лимитер для upload-эндпоинтов (уже защищены ролью admin,
// но ограничение частоты снижает ущерб от скомпрометированного токена
// и защищает диск/CPU от массовой обработки изображений).
export const uploadRateLimiter = rateLimit({
    windowMs: env.uploadRateLimit.windowMs,
    limit: env.uploadRateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitedResponse(
        "TOO_MANY_UPLOADS",
        "Слишком много загрузок. Попробуйте позже."
    ),
});

// Лимитер для публичного callback Steam OpenID - см. env.steamCallbackRateLimit.
export const steamCallbackRateLimiter = rateLimit({
    windowMs: env.steamCallbackRateLimit.windowMs,
    limit: env.steamCallbackRateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitedResponse(
        "TOO_MANY_STEAM_CALLBACK_ATTEMPTS",
        "Слишком много попыток. Попробуйте позже."
    ),
});

// Лимитер для публичной формы "Связаться" - эндпоинт не требует
// авторизации, поэтому единственная защита от спама/перебора - лимит
// по IP, как у loginRateLimiter.
export const contactRateLimiter = rateLimit({
    windowMs: env.contactRateLimit.windowMs,
    limit: env.contactRateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitedResponse(
        "TOO_MANY_CONTACT_REQUESTS",
        "Слишком много заявок. Попробуйте позже."
    ),
});

// PUT /api/stream/companion/gsi-state - авторизован companion-токеном
// (не по IP, как остальные лимитеры выше), но express-rate-limit по
// умолчанию считает по IP, что здесь и нужно: ограничивает одного
// сломанного/скомпрометированного клиента, реальная защита от "слишком
// часто" - троттлинг на стороне companion (см. отчёт), это just backstop.
export const streamCompanionRateLimiter = rateLimit({
    windowMs: env.streamCompanionRateLimit.windowMs,
    limit: env.streamCompanionRateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitedResponse(
        "TOO_MANY_COMPANION_UPDATES",
        "Слишком много обновлений состояния. Попробуйте позже."
    ),
});

// Лимитер для публичной отправки результата солитёра - без авторизации,
// единственная защита от спама по таблице рекордов - лимит по IP.
export const solitaireRateLimiter = rateLimit({
    windowMs: env.solitaireRateLimit.windowMs,
    limit: env.solitaireRateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitedResponse(
        "TOO_MANY_SOLITAIRE_SUBMISSIONS",
        "Слишком много отправок результата. Попробуйте позже."
    ),
});
