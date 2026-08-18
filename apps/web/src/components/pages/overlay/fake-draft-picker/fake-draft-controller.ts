import { useEffect, useState } from "react";

export const FAKE_DRAFT_STATES = ["enter", "idle", "scrolling", "lock", "wait"] as const;
export type FakeDraftState = (typeof FAKE_DRAFT_STATES)[number];

export interface FakeDraftSnapshot {
    state: FakeDraftState;
    // Стабильный (alphabetic) ростер минус исключённые id - карусель
    // скроллится вдоль этого массива, а не пересобирает случайное окно
    // соседей на каждом шаге (см. задачу: "не генерировать случайный набор
    // соседних карточек при каждой смене").
    roster: number[];
    // Герой в центральном слоте прямо сейчас (idle/lock/wait) или тот, с
    // которого мы только что стартовали (scrolling - см. targetHeroId).
    settledHeroId: number | null;
    // Куда лента едет прямо сейчас - только в состоянии "scrolling",
    // иначе null. Рендер-слой анимирует непрерывный скролл к этому id.
    targetHeroId: number | null;
    countdown: number;
    // Инкрементируется на каждом enter->idle (новая "сессия" fake-пика).
    // Рендер-слой использует это, чтобы отличить "перескочить на новый
    // случайный старт" (мгновенно) от "проскроллить к соседнему герою"
    // (анимированно) - см. hero-carousel.tsx.
    cycleId: number;
}

export interface UseFakeDraftControllerOptions {
    // Только "безопасные" id, которые вообще можно показать как fake pick.
    heroPool: number[];
    // Реально известные (через GSI) id - никогда не должны появиться как
    // fake pick, иначе совпадение fake-выбора с настоящим героем раскрывает
    // реальные данные (см. задачу WK-77, "не должен случайно раскрывать").
    excludedHeroIds?: number[];
    // Контроллер полностью останавливается вне substitute-режима/draft-фазы -
    // не тикает и не держит таймеры в фоне.
    active: boolean;
    random?: () => number;
}

// Jitter-диапазоны намеренно нигде не привязаны к реальным Dota-таймерам -
// см. задачу: "fake timer, hero changes и lock нельзя синхронизировать 1:1 с
// реальными событиями".
const DURATIONS_MS: Record<Exclude<FakeDraftState, "scrolling">, [number, number]> = {
    enter: [300, 650],
    idle: [900, 2200],
    lock: [1700, 2700],
    wait: [900, 1900],
};

// "scrolling" не читает из DURATIONS_MS - его длительность масштабируется по
// дистанции хопа (см. pickTarget/durationForCurrentState), чтобы длинный
// scroll ощутимо занимал больше времени, чем прыжок на 1-2 соседей.
const SCROLL_MS_PER_HOP: [number, number] = [140, 230];
const SCROLL_MS_RANGE: [number, number] = [380, 2600];

const COUNTDOWN_START: [number, number] = [24, 34];
// Сколько остановок/передумываний сделает fake-пользователь перед lock -
// см. задачу: "перед fake lock может быть несколько остановок/передумываний".
const MOVES_BEFORE_LOCK: [number, number] = [3, 6];

const randomInt = (random: () => number, [min, max]: [number, number]) =>
    Math.floor(min + random() * (max - min + 1));

const buildRoster = (pool: number[], excluded: Set<number>): number[] =>
    pool.filter((id) => !excluded.has(id));

// Чистая (без React) реализация машины состояний - обёрнута хуком ниже
// только ради подписки на таймеры и жизненный цикл компонента. Вынесена
// отдельно, чтобы можно было писать unit-тесты на переходы без RTL.
export class FakeDraftController {
    private random: () => number;
    private pool: number[];
    private excluded: Set<number>;
    private movesRemaining = 0;
    private lastDirection: 1 | -1 = 1;
    private lastStepDistance = 1;
    snapshot: FakeDraftSnapshot;

    constructor(options: { heroPool: number[]; excludedHeroIds?: number[]; random?: () => number }) {
        this.random = options.random ?? Math.random;
        this.pool = options.heroPool;
        this.excluded = new Set(options.excludedHeroIds ?? []);
        this.snapshot = {
            state: "enter",
            roster: buildRoster(this.pool, this.excluded),
            settledHeroId: null,
            targetHeroId: null,
            countdown: randomInt(this.random, COUNTDOWN_START),
            cycleId: 0,
        };
    }

    updateExclusions(excludedHeroIds: number[]) {
        this.excluded = new Set(excludedHeroIds);
        const roster = buildRoster(this.pool, this.excluded);
        let { settledHeroId, targetHeroId } = this.snapshot;

        // Герой, которого мы уже показываем как fake pick, может внезапно
        // оказаться реальным (раскрытым через GSI) в середине цикла - убрать
        // его немедленно, а не ждать следующего перехода состояния (см.
        // "реальные heroes должны исключаться согласно существующей логике").
        if (settledHeroId !== null && this.excluded.has(settledHeroId)) {
            settledHeroId = roster.length > 0 ? roster[Math.floor(this.random() * roster.length)] : null;
        }
        if (targetHeroId !== null && this.excluded.has(targetHeroId)) {
            targetHeroId = null;
        }

        this.snapshot = { ...this.snapshot, roster, settledHeroId, targetHeroId };
    }

    durationForCurrentState(): number {
        if (this.snapshot.state === "scrolling") {
            const perHop = randomInt(this.random, SCROLL_MS_PER_HOP);
            const [min, max] = SCROLL_MS_RANGE;
            return Math.min(max, Math.max(min, this.lastStepDistance * perHop));
        }
        return randomInt(this.random, DURATIONS_MS[this.snapshot.state]);
    }

    tickCountdown() {
        if (this.snapshot.state === "lock" || this.snapshot.state === "wait") return;
        this.snapshot = { ...this.snapshot, countdown: Math.max(0, this.snapshot.countdown - 1) };
    }

    // Выбирает target index внутри alphabetic roster относительно текущего
    // settled-героя - иногда вправо, иногда влево, иногда 1-2 героя, иногда
    // более длинный scroll, со смещением в сторону продолжения предыдущего
    // направления (но не всегда - направление может смениться).
    private pickTarget(): number | null {
        const { roster, settledHeroId } = this.snapshot;
        if (roster.length === 0) return null;
        if (roster.length === 1 || settledHeroId === null) return roster[0];

        const currentIndex = Math.max(roster.indexOf(settledHeroId), 0);
        const direction = (this.random() < 0.7 ? this.lastDirection : (this.lastDirection * -1)) as 1 | -1;

        const roll = this.random();
        const step =
            roll < 0.55
                ? randomInt(this.random, [1, 2])
                : roll < 0.85
                  ? randomInt(this.random, [3, 4])
                  : randomInt(this.random, [5, 7]);

        let targetIndex = currentIndex + direction * step;
        let resolvedDirection = direction;
        if (targetIndex < 0) {
            targetIndex = 0;
            resolvedDirection = 1;
        } else if (targetIndex >= roster.length) {
            targetIndex = roster.length - 1;
            resolvedDirection = -1;
        }
        // Ростер закончился ровно там, где мы уже стоим (край списка) -
        // подтолкнуть в единственную возможную сторону, чтобы scroll не
        // выродился в шаг длиной 0.
        if (targetIndex === currentIndex) {
            targetIndex = Math.min(Math.max(currentIndex + resolvedDirection, 0), roster.length - 1);
        }

        this.lastDirection = resolvedDirection;
        this.lastStepDistance = Math.max(1, Math.abs(targetIndex - currentIndex));
        return roster[targetIndex];
    }

    advance(): FakeDraftSnapshot {
        const s = this.snapshot;
        switch (s.state) {
            case "enter": {
                const roster = s.roster;
                const settledHeroId = roster.length > 0 ? roster[Math.floor(this.random() * roster.length)] : null;
                this.movesRemaining = randomInt(this.random, MOVES_BEFORE_LOCK);
                this.snapshot = {
                    ...s,
                    state: "idle",
                    settledHeroId,
                    targetHeroId: null,
                    countdown: randomInt(this.random, COUNTDOWN_START),
                    cycleId: s.cycleId + 1,
                };
                break;
            }
            case "idle": {
                if (this.movesRemaining <= 0 || s.roster.length === 0) {
                    this.snapshot = { ...s, state: "lock", targetHeroId: null };
                    break;
                }
                this.movesRemaining -= 1;
                this.snapshot = { ...s, state: "scrolling", targetHeroId: this.pickTarget() };
                break;
            }
            case "scrolling": {
                this.snapshot = {
                    ...s,
                    state: "idle",
                    settledHeroId: s.targetHeroId ?? s.settledHeroId,
                    targetHeroId: null,
                };
                break;
            }
            case "lock": {
                this.snapshot = { ...s, state: "wait" };
                break;
            }
            case "wait": {
                this.snapshot = { ...s, state: "enter" };
                break;
            }
        }
        return this.snapshot;
    }
}

export const useFakeDraftController = ({
    heroPool,
    excludedHeroIds = [],
    active,
    random,
}: UseFakeDraftControllerOptions): FakeDraftSnapshot => {
    // useState's lazy initializer (not useRef) is the sanctioned way to
    // construct an expensive, stable object once - reading ref.current during
    // render is disallowed by the react-hooks/refs rule.
    const [controller] = useState(() => new FakeDraftController({ heroPool, excludedHeroIds, random }));
    const [snapshot, setSnapshot] = useState(controller.snapshot);

    // "Adjusting state when a prop changes" pattern (react.dev) rather than
    // an effect - updateExclusions can correct the already-committed
    // settled/target hero (see FakeDraftController.updateExclusions), and
    // that correction must land before this render is shown, not one tick
    // later via an effect.
    const excludedKey = excludedHeroIds.join(",");
    const [prevExcludedKey, setPrevExcludedKey] = useState(excludedKey);
    if (prevExcludedKey !== excludedKey) {
        setPrevExcludedKey(excludedKey);
        controller.updateExclusions(excludedHeroIds);
        setSnapshot({ ...controller.snapshot });
    }

    useEffect(() => {
        if (!active) return;

        let cancelled = false;
        let timeoutId: ReturnType<typeof setTimeout>;

        const schedule = () => {
            const duration = controller.durationForCurrentState();
            timeoutId = setTimeout(() => {
                if (cancelled) return;
                setSnapshot(controller.advance());
                schedule();
            }, duration);
        };
        schedule();

        return () => {
            cancelled = true;
            clearTimeout(timeoutId);
        };
        // Самопланирующийся цикл читает состояние из controller (стабильный
        // ref), а не из React state - эффект должен запуститься один раз при
        // active=true и не перезапускаться на каждый переход состояния.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active]);

    useEffect(() => {
        if (!active) return;
        const intervalId = setInterval(() => {
            controller.tickCountdown();
            setSnapshot({ ...controller.snapshot });
        }, 1000);
        return () => clearInterval(intervalId);
    }, [active, controller]);

    return snapshot;
};
