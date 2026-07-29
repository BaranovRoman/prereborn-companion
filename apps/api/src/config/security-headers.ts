import helmet from "helmet";
import { env } from "./env.js";

// Этот Express-процесс отдаёт только JSON API (+ /uploads в dev, в проде
// nginx раздаёт /uploads напрямую, минуя Express — см. nginx.production.conf).
// CSP защищает HTML-страницы от XSS/inline-скриптов; здесь HTML не рендерится,
// поэтому полноценная CSP не добавляет реальной защиты и рискует мешать
// будущим интеграциям без пользы — отключаем её осознанно (решение
// зафиксировано в отчёте по аудиту).
//
// crossOriginEmbedderPolicy отключаем: 3D-сцены на фронте (matcap-текстуры,
// изображения кейсов) могут грузить /uploads через canvas/WebGL, а COEP
// требует Cross-Origin-Resource-Policy на каждом кросс-origin ресурсе —
// без реальной необходимости в изоляции (нет чужих iframe/воркеров) это
// лишний риск сломать текстуры.
export const securityHeaders = helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    hsts: env.isProduction
        ? {
              maxAge: 180 * 24 * 60 * 60, // 180 дней
              includeSubDomains: true,
          }
        : false,
});
