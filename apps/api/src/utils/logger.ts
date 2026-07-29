import { env } from "../config/env.js";

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

const currentLevel = LEVELS[env.logLevel as Level] ?? LEVELS.info;

const shouldLog = (level: Level): boolean => {
    if (env.isTest) return false;
    return LEVELS[level] >= currentLevel;
};

const write = (
    level: Level,
    message: string,
    meta?: Record<string, unknown>
) => {
    if (!shouldLog(level)) return;

    const line = {
        level,
        message,
        time: new Date().toISOString(),
        ...meta,
    };

    const method = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    method(JSON.stringify(line));
};

export const logger = {
    debug: (message: string, meta?: Record<string, unknown>) =>
        write("debug", message, meta),
    info: (message: string, meta?: Record<string, unknown>) =>
        write("info", message, meta),
    warn: (message: string, meta?: Record<string, unknown>) =>
        write("warn", message, meta),
    error: (message: string, meta?: Record<string, unknown>) =>
        write("error", message, meta),
};
