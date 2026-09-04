import type {
    BroadcastSceneId,
    DraftProtectionMode,
    OverlayLayout,
} from "@/entities/stream-overlay-layout/model/types";
import type { QueueSettings } from "@/entities/stream-queue-settings/model/types";
import type { TwitchIntegrationStatus } from "@/entities/twitch-integration/model/types";
import type { DonationAlertsIntegrationStatus } from "@/entities/donation-alerts-integration/model/types";
import type { TwitchViewerEvent, ViewerAlertsSettings } from "@/entities/twitch-viewer-alerts/model/types";

export interface StreamSession {
    id: string;
    streamUserId: string;
    rating: number | null;
    // WK-105 - кумулятивная абсолютная коррекция "Текущего MMR" за эту
    // сессию (см. backend stream-session-service.ts::
    // applyAbsoluteRatingCorrection) - 0, если её не было. Audit/
    // transparency-поле: `rating` уже содержит итоговое значение.
    ratingAdjustment: number;
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

// WK-53 - "итог стрима": all fields derive from the session row + matches
// already in the DB (backend: stream-session-summary-service.ts), nothing is
// invented/frozen at End-time - see that file's comment for why.
export interface SessionSummary {
    sessionId: string;
    wins: number;
    losses: number;
    matchCount: number;
    // Управляет тем, показывать ли ratingStart/ratingEnd/ratingDelta - как и
    // везде в приложении (SessionStats), для unranked они всегда null, а не
    // выдуманное значение.
    gameMode: StreamGameMode;
    ratingStart: number | null;
    ratingEnd: number | null;
    // WK-105 - только вклад матчей сессии, НЕ ratingEnd - ratingStart -
    // абсолютная коррекция Текущего MMR (ratingAdjustment ниже) сюда не
    // включается, поэтому ratingStart + ratingDelta может честно не сойтись
    // с ratingEnd, если коррекция была.
    ratingDelta: number | null;
    // WK-105 - кумулятивная абсолютная коррекция Текущего MMR за эту сессию,
    // не привязанная ни к одному матчу - 0, если её не было.
    ratingAdjustment: number;
    startedAt: string;
    endedAt: string | null;
    durationMs: number | null;
}

// WK-53 - three-state session lifecycle: "active" (stream in progress),
// "ended" (most recent session explicitly ended - see `summary`), "none"
// (this account has never had a stream_sessions row). GET /account/session
// and the Companion's GET /companion/session both key off this shape/idea -
// see controllers/stream/session.ts on the backend.
export type SessionLifecycleState = "active" | "ended" | "none";

export interface SessionLifecycleResponse {
    state: SessionLifecycleState;
    session: StreamSession | null;
    summary: SessionSummary | null;
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
    // WK-89: публичный overlay-payload (controllers/stream/overlay.ts) ТЕПЕРЬ
    // тоже отдаёт это поле на обоих полях (matches и recentMatches) - без
    // него isMatchFromCurrentSession не могла отличить текущую/прошлую
    // сессию на реальном overlay, и opacity-часть WK-84 не работала на
    // публичной сцене (работала только на authenticated-дашборде). Остаётся
    // optional ради обратной совместимости типа с более старыми ответами.
    streamSessionId?: string | null;
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
    // WK-105 - разбивка ratingDelta: ratingDelta = detectedRatingDelta +
    // ratingDeltaCorrection. detectedRatingDelta - null, если auto-detect по
    // этому матчу ни разу не отработал (unranked/неизвестный режим, либо
    // строка мигрирована до WK-105 без возможности восстановить исходное
    // значение) - см. backend db/migrate.ts.
    detectedRatingDelta: number | null;
    ratingDeltaCorrection: number;
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
    // WK-53 - "ended" forces the public overlay into the calm final scene
    // (see get-broadcast-scene usage in overlay/index.tsx) regardless of
    // sceneOverride/companion payload - a stale/reconnecting GSI tick from a
    // Companion that's still running must not be misread as "still playing".
    // "none" behaves like "active" scene-wise (a brand-new account's very
    // first overlay poll) - see controllers/stream/overlay.ts.
    sessionState: SessionLifecycleState;
    sessionSummary: SessionSummary | null;
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
    // Temporary test-mode override. Normally the scene is derived from GSI.
    sceneOverride: BroadcastSceneId | null;
    // Snapshot of draftProtection.mode captured when the "draft" test scene
    // was triggered - null unless sceneOverride is "draft". Lets a manual
    // OBS test show the exact saved mode without depending on `layout`
    // being re-fetched at the same instant (see obs-scene-command-service.ts).
    draftProtectionModeOverride: DraftProtectionMode | null;
    // Последние завершённые матчи, новые сверху (см. ORDER BY ended_at DESC
    // в stream-match-service.ts) - пусто, пока не завершился ни один матч.
    matches: StreamMatch[];
    recentMatches?: StreamMatch[];
    companion: OverlayCompanionState;
    steam: {
        connected: boolean;
        profile: {
            displayName: string;
            avatarUrl: string | null;
            profileUrl: string | null;
        } | null;
    };
    // WK-148 - Between Matches enrichment (Favorite Heroes current-patch line
    // + "ПРОФИЛЬ ИГРОКА" радар), null when Steam isn't linked. Both
    // sub-fields are independently null on a cold cache/upstream failure -
    // see apps/api's opendota-overlay-insights-cache-service.ts, which never
    // blocks this endpoint's response on OpenDota (stale-while-refresh,
    // fills in on a later poll).
    openDota: {
        favoriteHeroes: {
            patchName: string | null;
            // WK-148 polish - true only when confirmed to be OpenDota's
            // current known patch, not just the newest one this player has
            // played (see apps/api's resolveCurrentPatchId doc comment).
            isLatestKnown: boolean;
            perHero: Record<
                number,
                {
                    lifetime: { games: number; wins: number; losses: number; winRate: number } | null;
                    patch: { games: number; wins: number; losses: number; winRate: number } | null;
                }
            >;
        } | null;
        radar: {
            combat: number | null;
            farm: number | null;
            support: number | null;
            objectives: number | null;
            flexibility: number | null;
            insufficientSample: boolean;
        } | null;
    } | null;
    twitch: TwitchIntegrationStatus;
    donationAlerts: DonationAlertsIntegrationStatus | null;
    // WK-72 - follow/subscribe/gift-sub/raid, bounded + deduped server-side
    // (twitch-integration-service.ts) same shape as chat.messages above.
    viewerEvents: TwitchViewerEvent[];
    viewerAlertsSettings: ViewerAlertsSettings;
    // Раскладка виджетов - приходит в том же payload'е, что и остальные
    // данные (см. задачу: не заводить отдельный поллинг под layout).
    layout: OverlayLayout;
    queueSettings: QueueSettings;
}
