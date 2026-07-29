import { randomUUID } from "crypto";
import { Request, Response, NextFunction } from "express";

// Принимаем клиентский X-Request-Id, только если он выглядит как разумный
// идентификатор (короткий, без управляющих символов) — иначе генерируем свой.
const isValidRequestId = (value: string): boolean =>
    value.length > 0 && value.length <= 128 && /^[\x20-\x7e]+$/.test(value);

export const requestId = (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.headers["x-request-id"];
    const candidate = Array.isArray(incoming) ? incoming[0] : incoming;

    const id = candidate && isValidRequestId(candidate) ? candidate : randomUUID();

    req.requestId = id;
    res.setHeader("X-Request-Id", id);
    next();
};
