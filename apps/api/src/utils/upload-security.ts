import crypto from "crypto";
import path from "path";
import fs from "fs/promises";
import multer from "multer";
import { fileTypeFromFile } from "file-type";
import sharp from "sharp";
import { logger } from "./logger.js";

// Ограничения decode-бомб: отклоняем изображения с чрезмерными габаритами/
// количеством пикселей ещё до полной перекодировки.
const MAX_IMAGE_DIMENSION_PX = 6000;
const MAX_IMAGE_PIXELS = 30_000_000; // ~30MP

const ALLOWED_IMAGE_MIME = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
]);

const ALLOWED_VIDEO_MIME = new Set([
    "video/mp4",
    "video/webm",
    "video/quicktime", // .mov
    "video/x-msvideo", // .avi
]);

// Имя на диске не зависит от клиента — только случайные байты. Расширение
// добавляется отдельно, уже после проверки реальной сигнатуры содержимого.
export const generateRandomBasename = (): string =>
    crypto.randomBytes(16).toString("hex");

// Хранилище multer: пишет во временное имя без расширения, чтобы сервер
// сам решал финальное имя/расширение по итогам проверки содержимого.
export const createUploadStorage = (uploadsDir: string) =>
    multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, uploadsDir),
        filename: (_req, _file, cb) => cb(null, generateRandomBasename()),
    });

// Путь обязан находиться строго внутри uploadsDir — защита от path traversal
// как при формировании итогового имени, так и при удалении по имени из БД.
export const isInsideUploadsDir = (
    uploadsDir: string,
    targetPath: string
): boolean => {
    const base = path.resolve(uploadsDir) + path.sep;
    const resolved = path.resolve(targetPath);
    return resolved.startsWith(base);
};

export const safeUnlink = async (filePath: string): Promise<void> => {
    try {
        await fs.unlink(filePath);
    } catch {
        // Файла может уже не быть — не критично при cleanup.
    }
};

// Профиль загрузки определяет максимальную сторону мастер-файла и решает,
// применять ли лёгкий sharpen после resize. "hero"/"content" - реальные
// скриншоты интерфейсов (портфолио веб-разработчика), поэтому мягкий
// sharpen применяется по профилю (контекст загрузки), а не через
// ненадёжное определение "фото это или скриншот" по содержимому.
// "og" - отдельный профиль для Open Graph превью кейса (case.og_image):
// в отличие от остальных, перекодируется в JPEG, а не WebP - см. ветку
// isOgProfile ниже. Соцсети/краулеры (в первую очередь старые интеграции с
// Facebook/Slack) надёжнее всего работают именно с JPEG/PNG для og:image,
// WebP там историчeски был не универсально поддержан.
export type UploadProfile = "hero" | "content" | "generic" | "og" | "streamReference";

const PROFILE_MAX_WIDTH: Record<UploadProfile, number> = {
    hero: 2560,
    content: 2000,
    generic: 2560,
    // Рекомендуемая ширина OG-картинки - 1200 (см. подсказку в админке) -
    // здесь только защитный кап от чрезмерно больших загрузок, не
    // принудительный кроп: admin готовит нужный кадр/пропорцию заранее.
    og: 1200,
    // Референс-скриншот HUD для overlay-редактора (см. задачу) - кап и по
    // ширине, и по высоте (PROFILE_MAX_HEIGHT ниже), в отличие от остальных
    // профилей, где ограничена только ширина.
    streamReference: 2560,
};

// Только у streamReference задан отдельный кап по высоте - скриншоты игры
// почти всегда landscape, но без явного лимита по высоте очень узкое/высокое
// изображение прошло бы через resize({width}) не ужавшись по факту.
const PROFILE_MAX_HEIGHT: Partial<Record<UploadProfile, number>> = {
    streamReference: 1440,
};

const isValidUploadProfile = (value: unknown): value is UploadProfile =>
    value === "hero" ||
    value === "content" ||
    value === "generic" ||
    value === "og" ||
    value === "streamReference";

export const parseUploadProfile = (value: unknown): UploadProfile =>
    isValidUploadProfile(value) ? value : "generic";

interface ImageCheckResult {
    ok: true;
    finalPath: string;
    finalFilename: string;
    mime: string;
    width: number;
    height: number;
    sizeBytes: number;
}

interface ImageCheckFailure {
    ok: false;
    reason: "unsupported-signature" | "dimensions-too-large" | "decode-failed";
}

// Проверяет реальную сигнатуру файла (не расширение/mimetype из запроса),
// ограничивает габариты и перекодирует растровые форматы через sharp в
// WebP-мастер заданного профиля - это снимает EXIF/метаданные и любые
// полиглот-вставки, применяет EXIF-ориентацию (.rotate()) и никогда не
// увеличивает исходник (withoutEnlargement). Анимированные GIF не
// перекодируются (сохраняем анимацию), но сигнатура и размеры всё равно
// проверяются.
export const validateAndFinalizeImage = async (
    tempPath: string,
    uploadsDir: string,
    profile: UploadProfile = "generic"
): Promise<ImageCheckResult | ImageCheckFailure> => {
    const type = await fileTypeFromFile(tempPath);

    if (!type || !ALLOWED_IMAGE_MIME.has(type.mime)) {
        return { ok: false, reason: "unsupported-signature" };
    }

    try {
        const image = sharp(tempPath, { limitInputPixels: MAX_IMAGE_PIXELS });
        const metadata = await image.metadata();

        if (
            (metadata.width ?? 0) > MAX_IMAGE_DIMENSION_PX ||
            (metadata.height ?? 0) > MAX_IMAGE_DIMENSION_PX
        ) {
            return { ok: false, reason: "dimensions-too-large" };
        }

        const basename = path.basename(tempPath);

        if (type.mime === "image/gif") {
            // Анимация - перекодировать нечем без потери кадров, оставляем как есть.
            const finalFilename = `${basename}.${type.ext}`;
            const finalPath = path.join(uploadsDir, finalFilename);
            await fs.rename(tempPath, finalPath);
            const stat = await fs.stat(finalPath);
            return {
                ok: true,
                finalPath,
                finalFilename,
                mime: type.mime,
                width: metadata.width ?? 0,
                height: metadata.height ?? 0,
                sizeBytes: stat.size,
            };
        }

        let pipeline = image.rotate().resize({
            width: PROFILE_MAX_WIDTH[profile],
            height: PROFILE_MAX_HEIGHT[profile],
            withoutEnlargement: true,
            fit: "inside",
        });

        if (profile === "hero" || profile === "content") {
            pipeline = pipeline.sharpen({ sigma: 0.6, m1: 0.5, m2: 0.2 });
        }

        const isOgProfile = profile === "og";
        // streamReference - реальный скриншот игрового HUD, а не
        // подготовленный дизайн-ассет - quality 80 достаточно и держит файл
        // компактным (см. задачу).
        const webpQuality = profile === "streamReference" ? 80 : 84;
        const recoded = isOgProfile
            ? await pipeline.jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true })
            : await pipeline
                  .webp({ quality: webpQuality, effort: 5, smartSubsample: true })
                  .toBuffer({ resolveWithObject: true });

        const finalFilename = `${basename}.${isOgProfile ? "jpg" : "webp"}`;
        const finalPath = path.join(uploadsDir, finalFilename);
        await fs.writeFile(finalPath, recoded.data);
        await safeUnlink(tempPath);

        return {
            ok: true,
            finalPath,
            finalFilename,
            mime: isOgProfile ? "image/jpeg" : "image/webp",
            width: recoded.info.width,
            height: recoded.info.height,
            sizeBytes: recoded.info.size,
        };
    } catch (error) {
        logger.error("Image validation/recode failed", {
            message: error instanceof Error ? error.message : String(error),
        });
        return { ok: false, reason: "decode-failed" };
    }
};

interface VideoCheckResult {
    ok: true;
    finalPath: string;
    finalFilename: string;
    mime: string;
}

interface VideoCheckFailure {
    ok: false;
    reason: "unsupported-signature";
}

// Проверяет реальную сигнатуру контейнера видео (magic bytes), не только
// mimetype/расширение из запроса. Транскодирование не выполняется.
export const validateAndFinalizeVideo = async (
    tempPath: string,
    uploadsDir: string
): Promise<VideoCheckResult | VideoCheckFailure> => {
    const type = await fileTypeFromFile(tempPath);

    if (!type || !ALLOWED_VIDEO_MIME.has(type.mime)) {
        return { ok: false, reason: "unsupported-signature" };
    }

    const basename = path.basename(tempPath);
    const finalFilename = `${basename}.${type.ext}`;
    const finalPath = path.join(uploadsDir, finalFilename);
    await fs.rename(tempPath, finalPath);

    return { ok: true, finalPath, finalFilename, mime: type.mime };
};
