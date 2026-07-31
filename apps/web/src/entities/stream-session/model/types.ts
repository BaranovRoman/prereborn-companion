import type { OverlayLayout } from "@/entities/stream-overlay-layout/model/types";
import type { QueueSettings } from "@/entities/stream-queue-settings/model/types";
import type { TwitchIntegrationStatus } from "@/entities/twitch-integration/model/types";

export interface StreamSession {
    id: string;
    streamUserId: string;
    rating: number | null;
    wins: number;
    losses: number;
    lastHeroId: number | null;
    startedAt: string;
    endedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface StreamSessionPatch {
    rating?: number | null;
    wins?: number;
    losses?: number;
    lastHeroId?: number | null;
}

// Последнее GSI-состояние от companion (apps/dota-companion), уже
// санитизировано на backend (services/stream-companion-service.ts) - здесь
// не может быть auth/token/password полей. payload - произвольный JSON без
// строгой схемы (структура GSI не документирована Valve формально), поэтому
// unknown, а не конкретный тип - debug-панель (components/pages/overlay)
// извлекает известные поля защитно, без предположений об их наличии.
export interface OverlayCompanionState {
    isOnline: boolean;
    receivedAt: string | null;
    companionVersion: string | null;
    payload: unknown | null;
}

// Один завершённый матч, распознанный из GSI (backend:
// services/stream-match-service.ts) - heroName/heroImageUrl намеренно нет
// в API-ответе: бэкенд сервиса стрим-оверлеев не знает про Dota/OpenDota
// (см. комментарий у lastHeroId ниже), разрешение heroId -> имя/иконка
// происходит на фронтенде через entities/dota-hero, как и для lastHeroId.
// ratingDelta/ratingAfter - null, если rating сессии на момент матча был
// неизвестен (см. задачу: не выдумывать абсолютный рейтинг) - публичный
// overlay это тоже честно отражает, а не подставляет 0.
export type StreamGameMode = "ranked" | "unranked";

// ABANDON - третий, взаимоисключающий с win/loss результат (только ручной
// выбор пользователем в истории/QuickMatchPanel, см. задачу - GSI по-прежнему
// пишет исключительно win/loss, backend stream-match-service.ts).
export type MatchResult = "win" | "loss" | "abandon";

// Явный жизненный цикл матча (см. backend stream-match-service.ts) -
// "needs_review" - единственное не-финализированное состояние, которое
// вообще может попасть сюда (в authenticated-историю), у него result может
// быть null (спорный исход GSI ещё не подтверждён). Публичный overlay
// отдаёт только "finalized" - см. controllers/stream/overlay.ts.
export type MatchState = "finalized" | "needs_review";

export interface StreamMatch {
    id: string;
    dotaMatchId: string | null;
    heroId: number;
    kills: number;
    deaths: number;
    assists: number;
    inventory: Array<string | null>;
    // null - только у needs_review-матчей (см. AccountStreamMatch): спорный
    // исход, который GSI не смог уверенно определить, ещё не разрешён.
    result: MatchResult | null;
    ratingBefore: number | null;
    ratingDelta: number | null;
    ratingAfter: number | null;
    // Зафиксировано на момент финализации матча (см. backend
    // stream-match-service.ts) - смена пользователем текущего режима
    // (entities/stream-user) не меняет отображение уже записанных матчей.
    gameMode: StreamGameMode;
    endedAt: string | null;
}

export type MatchResultSource = "gsi" | "manual";
export type MatchRatingSource = "default" | "manual" | null;

// Полная форма матча для authenticated-истории (GET
// /api/stream/account/me/matches) - добавляет поля аудита корректировки,
// которых нет в компактном публичном overlay-payload'е.
export interface AccountStreamMatch extends StreamMatch {
    isRanked: boolean | null;
    streamSessionId: string | null;
    resultSource: MatchResultSource;
    ratingSource: MatchRatingSource;
    correctedAt: string | null;
    state: MatchState;
}

// Команда ручной корректировки (PATCH .../matches/:id) - ratingDelta и
// ratingAfter взаимоисключающие, см. match-history-panel.tsx и backend
// controllers/stream/matches.ts. discard - "не учитывать" (только для
// state === "needs_review"), несовместим с остальными полями.
export interface MatchCorrectionCommand {
    result?: MatchResult;
    ratingDelta?: number;
    ratingAfter?: number;
    isRanked?: boolean;
    discard?: boolean;
}

export interface MatchCorrectionResponse {
    match: AccountStreamMatch;
    session: StreamSession | null;
}

// Публичная форма (GET /api/stream/overlay/:publicToken) - без id/timestamps
// сессии и без streamUserId, см. controllers/stream/overlay.ts на бэкенде.
export interface OverlayData {
    rating: number | null;
    // Суммарное изменение rating за текущую сессию (текущий - рейтинг перед
    // самым первым ranked-матчем сессии) - null для unranked, где рейтинг
    // вообще не показывается (см. SessionStats). 0, если в сессии ещё не
    // было ranked-матчей с известным ratingBefore - изменения ещё не было.
    sessionRatingDelta: number | null;
    wins: number;
    losses: number;
    lastHeroId: number | null;
    updatedAt: string;
    // Текущий режим пользователя (см. entities/stream-user) - управляет тем,
    // показывает ли SessionStats MMR или только W/L.
    gameMode: StreamGameMode;
    // Последние завершённые матчи, новые сверху (см. ORDER BY ended_at DESC
    // в stream-match-service.ts) - пусто, пока не завершился ни один матч.
    matches: StreamMatch[];
    companion: OverlayCompanionState;
    steam: {
        connected: boolean;
        profile: {
            displayName: string;
            avatarUrl: string | null;
            profileUrl: string | null;
        } | null;
    };
    twitch: TwitchIntegrationStatus;
    // Раскладка виджетов - приходит в том же payload'е, что и остальные
    // данные (см. задачу: не заводить отдельный поллинг под layout).
    layout: OverlayLayout;
    queueSettings: QueueSettings;
}
