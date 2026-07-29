import { Request, Response } from "express";
import { z } from "zod";
import { listMatchesForAccount } from "../../services/stream-match-service.js";
import {
    AbandonRatingEditError,
    correctStreamMatch,
    MatchNotEditableError,
    MatchNotFoundError,
    RankedRatingRequiredError,
    UnrankedRatingEditError,
} from "../../services/stream-match-correction-service.js";
import { logger } from "../../utils/logger.js";

// req.streamUserId гарантирован authenticateStreamUser (routes/stream/account.ts).
// Ни один из этих контроллеров не принимает id пользователя от клиента -
// матч всегда ищется в рамках "моих" записей (WHERE stream_user_id = $2 в
// сервисе), поэтому чужой матч в принципе не адресуем.

export const getMatchesController = async (req: Request, res: Response) => {
    try {
        const matches = await listMatchesForAccount(req.streamUserId as string);
        res.json(matches);
    } catch (error) {
        logger.error("Stream get matches error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};

const matchIdParamSchema = z.coerce.number().int().positive();

// ratingDelta и ratingAfter взаимоисключающие - одновременная передача обоих
// это противоречивая команда (см. задачу, п.4), отклоняем на уровне схемы,
// а не молча выбираем один из них. Аналогично result: "abandon" вместе с
// ratingDelta/ratingAfter - тоже противоречивая команда (ABANDON всегда -25,
// ручная дельта для него не допускается, см. correctStreamMatch) - отклоняем
// здесь же, для быстрого 400 без похода в сервис. discard ("не учитывать",
// разрешение needs_review) несовместим со всеми остальными полями - это
// самостоятельное действие, а не модификатор результата/рейтинга.
const patchMatchSchema = z
    .object({
        result: z.enum(["win", "loss", "abandon"]).optional(),
        ratingDelta: z.number().int().min(-1000).max(1000).optional(),
        ratingAfter: z.number().int().min(1).max(50000).optional(),
        isRanked: z.boolean().optional(),
        discard: z.boolean().optional(),
    })
    .refine((data) => !(data.ratingDelta !== undefined && data.ratingAfter !== undefined), {
        message: "ratingDelta and ratingAfter cannot both be provided",
    })
    .refine(
        (data) =>
            !(data.result === "abandon" && (data.ratingDelta !== undefined || data.ratingAfter !== undefined)),
        { message: "ratingDelta/ratingAfter cannot be set manually for an abandoned match" }
    )
    .refine(
        (data) =>
            !(
                data.discard &&
                (data.result !== undefined ||
                    data.ratingDelta !== undefined ||
                    data.ratingAfter !== undefined ||
                    data.isRanked !== undefined)
            ),
        { message: "discard cannot be combined with result/ratingDelta/ratingAfter/isRanked" }
    );

export const patchMatchController = async (req: Request, res: Response) => {
    try {
        const matchId = matchIdParamSchema.parse(req.params.matchId);
        const command = patchMatchSchema.parse(req.body);

        const result = await correctStreamMatch(
            req.streamUserId as string,
            matchId.toString(),
            command
        );
        res.json(result);
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors });
        }
        if (error instanceof MatchNotFoundError) {
            return res.status(404).json({ error: "Матч не найден" });
        }
        if (error instanceof UnrankedRatingEditError) {
            return res
                .status(400)
                .json({ error: "Рейтинг недоступен для unranked-матча" });
        }
        if (error instanceof AbandonRatingEditError) {
            return res
                .status(400)
                .json({ error: "Дельта рейтинга недоступна для abandon-матча" });
        }
        if (error instanceof RankedRatingRequiredError) {
            return res.status(400).json({
                error: "Для рейтингового матча укажите изменение или итоговый рейтинг",
            });
        }
        if (error instanceof MatchNotEditableError) {
            return res.status(409).json({ error: "Матч ещё не завершён и недоступен для правки" });
        }
        logger.error("Stream patch match error", {
            requestId: req.requestId,
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
};
