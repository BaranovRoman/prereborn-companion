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

// WK-116 Phase 4 - the Twitch Video Overlay Extension's iframe runs on a
// Twitch-hosted origin scoped to this extension's own Client ID
// (https://<client_id>.ext-twitch.tv), not a domain we control or can add
// to CORS_ALLOWED_ORIGINS by exact string before the extension is even
// registered (that id doesn't exist yet - see the Phase 4 delivery report's
// external-gate instructions). Matched by pattern instead, scoped to
// Twitch's own real hosting domain - never a wildcard. This only ever
// applies from Hosted Test onward (Twitch's own CDN serving the assets) -
// see EXTENSION_LOCAL_TEST_ORIGIN_PATTERN below for the earlier Local Test
// stage.
const EXTENSION_ORIGIN_PATTERN = /^https:\/\/[a-z0-9]+\.ext-twitch\.tv$/;
// Deprecated (Twitch ended Developer Rig support in 2023) - kept for
// backward compatibility with anyone still on that flow, but the current
// documented one (docs/twitch-extension-setup.md §5a) is the pattern below.
const EXTENSION_RIG_ORIGIN = "https://localhost.rig.twitch.tv:8080";
// WK-157 - during Local Test (the CURRENT documented flow, not the
// deprecated Rig above), the extension's assets are served from the
// developer's OWN machine over a self-signed HTTPS server
// (docs/twitch-extension-setup.md §5a: `npx http-server ... -S -p 8443`,
// port is just that doc's example, not a fixed requirement) and installed
// for real on the streamer's own channel - the browser then loads
// twitch.tv/<you> and embeds the extension iframe with its `src` pointing
// straight at that local server, so the ORIGIN of every fetch() this
// extension makes is that local server, not (yet) any *.ext-twitch.tv
// domain and not the deprecated Rig's fixed origin either. Without this,
// every request during Local Test was silently rejected by CORS - the
// extension's own fetch calls would fail closed exactly like a genuine
// network outage (see hitbox-logic.ts's fail-closed staleness handling),
// which looks identical to "the interaction layer doesn't work" with no
// visible error anywhere, since Companion's own quiz board renders through
// a completely separate connection and is unaffected either way. Scoped to
// loopback origins only (127.0.0.1/localhost, any port) - this can't be
// used to bypass CORS for an arbitrary real origin, and a request still
// needs a Twitch-signed Extension JWT to do anything past this layer.
const EXTENSION_LOCAL_TEST_ORIGIN_PATTERN = /^https:\/\/(127\.0\.0\.1|localhost):\d+$/;

export const isTwitchExtensionOrigin = (origin: string): boolean =>
    origin === EXTENSION_RIG_ORIGIN ||
    EXTENSION_ORIGIN_PATTERN.test(origin) ||
    EXTENSION_LOCAL_TEST_ORIGIN_PATTERN.test(origin);

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

        if (allowedOrigins.includes(origin) || isTwitchExtensionOrigin(origin)) {
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
