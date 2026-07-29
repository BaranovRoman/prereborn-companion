import { CorsOptions } from "cors";
import { env } from "./env.js";
import { AppError } from "../utils/app-error.js";
import { logger } from "../utils/logger.js";

// Локальные origin разработки: Next.js фронтенд, Vite-админка, альтернативный localhost.
const DEV_ORIGINS = [
    "http://localhost:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:3001",
];

const allowedOrigins = env.isProduction
    ? env.corsAllowedOrigins
    : [...env.corsAllowedOrigins, ...DEV_ORIGINS];

// Логируем разрешённые origin'ы при старте без секретов - без этого
// молчаливо пустой CORS_ALLOWED_ORIGINS в production диагностируется только
// по жалобе пользователя на "Origin not allowed by CORS" в браузере.
if (env.isProduction && env.corsAllowedOrigins.length === 0) {
    logger.warn(
        "CORS_ALLOWED_ORIGINS is empty in production - every browser origin will be rejected"
    );
} else {
    logger.info("CORS allowed origins", { allowedOrigins });
}

export const corsOptions: CorsOptions = {
    origin: (origin, callback) => {
        // Запросы без Origin (curl, healthcheck, server-to-server, мобильные клиенты)
        // не блокируем — они не подвержены той же угрозе, что и браузерный CORS.
        if (!origin) {
            return callback(null, true);
        }

        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }

        return callback(
            new AppError("Origin not allowed by CORS", 403, "CORS_NOT_ALLOWED")
        );
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
    exposedHeaders: ["X-Request-Id"],
};
