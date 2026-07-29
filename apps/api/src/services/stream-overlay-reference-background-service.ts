import path from "path";
import { pool } from "../db/client.js";
import { safeUnlink, isInsideUploadsDir } from "../utils/upload-security.js";

export interface StreamOverlayReferenceBackground {
    filename: string;
    width: number;
    height: number;
    opacity: number;
}

interface ReferenceBackgroundRow {
    filename: string;
    width: number;
    height: number;
    opacity: number;
}

export const getReferenceBackground = async (
    streamUserId: string
): Promise<StreamOverlayReferenceBackground | null> => {
    const result = await pool.query<ReferenceBackgroundRow>(
        `SELECT filename, width, height, opacity
         FROM stream_overlay_reference_backgrounds
         WHERE stream_user_id = $1`,
        [streamUserId]
    );
    return result.rows[0] ?? null;
};

// Заменяет референс-скриншот целиком: сохраняет новую запись и удаляет файл
// предыдущей (если была) - вызывающий код (controller) отвечает за то, чтобы
// сам новый файл уже лежал в uploadsDir на момент вызова.
export const saveReferenceBackground = async (
    streamUserId: string,
    uploadsDir: string,
    input: { filename: string; width: number; height: number }
): Promise<StreamOverlayReferenceBackground> => {
    const previous = await getReferenceBackground(streamUserId);

    const opacity = previous?.opacity ?? 0.7;
    await pool.query(
        `INSERT INTO stream_overlay_reference_backgrounds
            (stream_user_id, filename, width, height, opacity)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (stream_user_id)
         DO UPDATE SET filename = $2, width = $3, height = $4, opacity = $5,
            updated_at = CURRENT_TIMESTAMP`,
        [streamUserId, input.filename, input.width, input.height, opacity]
    );

    if (previous && previous.filename !== input.filename) {
        const previousPath = path.join(uploadsDir, previous.filename);
        if (isInsideUploadsDir(uploadsDir, previousPath)) {
            await safeUnlink(previousPath);
        }
    }

    return { ...input, opacity };
};

export const setReferenceBackgroundOpacity = async (
    streamUserId: string,
    opacity: number
): Promise<StreamOverlayReferenceBackground | null> => {
    const result = await pool.query<ReferenceBackgroundRow>(
        `UPDATE stream_overlay_reference_backgrounds
         SET opacity = $2, updated_at = CURRENT_TIMESTAMP
         WHERE stream_user_id = $1
         RETURNING filename, width, height, opacity`,
        [streamUserId, opacity]
    );
    return result.rows[0] ?? null;
};

export const deleteReferenceBackground = async (
    streamUserId: string,
    uploadsDir: string
): Promise<void> => {
    const result = await pool.query<ReferenceBackgroundRow>(
        `DELETE FROM stream_overlay_reference_backgrounds
         WHERE stream_user_id = $1
         RETURNING filename`,
        [streamUserId]
    );
    const deleted = result.rows[0];
    if (!deleted) return;

    const filePath = path.join(uploadsDir, deleted.filename);
    if (isInsideUploadsDir(uploadsDir, filePath)) {
        await safeUnlink(filePath);
    }
};
