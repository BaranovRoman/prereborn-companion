import { useEffect, useState } from "react";

export const FAKE_DRAFT_STATES = [
    "enter",
    "idle",
    "hover",
    "carouselMove",
    "lock",
    "wait",
] as const;
export type FakeDraftState = (typeof FAKE_DRAFT_STATES)[number];

export interface FakeDraftSnapshot {
    state: FakeDraftState;
    focusedHeroId: number | null;
    hoverHeroId: number | null;
    carouselHeroIds: number[];
    countdown: number;
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
    carouselWindow?: number;
}

// Jitter-диапазоны намеренно нигде не привязаны к реальным Dota-таймерам -
// см. задачу: "fake timer, hero changes и lock нельзя синхронизировать 1:1 с
// реальными событиями".
const DURATIONS_MS: Record<Exclude<FakeDraftState, "wait">, [number, number]> & { wait: [number, number] } = {
    enter: [300, 650],
    idle: [1400, 2300],
    hover: [450, 950],
    carouselMove: [550, 950],
    lock: [1700, 2700],
    wait: [900, 1900],
};

const COUNTDOWN_START: [number, number] = [24, 34];

const randomInt = (random: () => number, [min, max]: [number, number]) =>
    Math.floor(min + random() * (max - min + 1));

const pickHeroId = (
    pool: number[],
    excluded: Set<number>,
    avoid: number | null,
    random: () => number
): number | null => {
    const candidates = pool.filter((id) => !excluded.has(id) && id !== avoid);
    if (candidates.length === 0) {
        const fallback = pool.filter((id) => !excluded.has(id));
        return fallback.length > 0 ? fallback[Math.floor(random() * fallback.length)] : null;
    }
    return candidates[Math.floor(random() * candidates.length)];
};

const buildCarousel = (
    pool: number[],
    excluded: Set<number>,
    center: number | null,
    windowSize: number,
    random: () => number
): number[] => {
    const safePool = pool.filter((id) => !excluded.has(id));
    if (safePool.length === 0) return [];
    const centerIndex = center !== null ? Math.max(safePool.indexOf(center), 0) : Math.floor(random() * safePool.length);
    const half = Math.floor(windowSize / 2);
    return Array.from({ length: Math.min(windowSize, safePool.length) }, (_, i) => {
        const index = (centerIndex - half + i + safePool.length * windowSize) % safePool.length;
        return safePool[index];
    });
};

// Чистая (без React) реализация машины состояний - обёрнута хуком ниже
// только ради подписки на таймеры и жизненный цикл компонента. Вынесена
// отдельно, чтобы можно было писать unit-тесты на переходы без RTL.
export class FakeDraftController {
    private random: () => number;
    private pool: number[];
    private excluded: Set<number>;
    private windowSize: number;
    private cyclesRemaining = 0;
    snapshot: FakeDraftSnapshot;

    constructor(options: { heroPool: number[]; excludedHeroIds?: number[]; random?: () => number; carouselWindow?: number }) {
        this.random = options.random ?? Math.random;
        this.pool = options.heroPool;
        this.excluded = new Set(options.excludedHeroIds ?? []);
        this.windowSize = options.carouselWindow ?? 7;
        this.snapshot = {
            state: "enter",
            focusedHeroId: null,
            hoverHeroId: null,
            carouselHeroIds: [],
            countdown: randomInt(this.random, COUNTDOWN_START),
        };
    }

    updateExclusions(excludedHeroIds: number[]) {
        this.excluded = new Set(excludedHeroIds);
    }

    durationForCurrentState(): number {
        return randomInt(this.random, DURATIONS_MS[this.snapshot.state]);
    }

    tickCountdown() {
        if (this.snapshot.state === "lock" || this.snapshot.state === "wait") return;
        this.snapshot = { ...this.snapshot, countdown: Math.max(0, this.snapshot.countdown - 1) };
    }

    advance(): FakeDraftSnapshot {
        const s = this.snapshot;
        switch (s.state) {
            case "enter": {
                const focused = pickHeroId(this.pool, this.excluded, null, this.random);
                this.cyclesRemaining = randomInt(this.random, [2, 4]);
                this.snapshot = {
                    state: "idle",
                    focusedHeroId: focused,
                    hoverHeroId: null,
                    carouselHeroIds: buildCarousel(this.pool, this.excluded, focused, this.windowSize, this.random),
                    countdown: randomInt(this.random, COUNTDOWN_START),
                };
                break;
            }
            case "idle": {
                const hoverHeroId = pickHeroId(this.pool, this.excluded, s.focusedHeroId, this.random);
                this.snapshot = { ...s, state: "hover", hoverHeroId };
                break;
            }
            case "hover": {
                this.cyclesRemaining -= 1;
                if (this.cyclesRemaining <= 0) {
                    this.snapshot = { ...s, state: "lock", hoverHeroId: null };
                } else {
                    this.snapshot = { ...s, state: "carouselMove" };
                }
                break;
            }
            case "carouselMove": {
                const nextFocused = s.hoverHeroId ?? s.focusedHeroId;
                this.snapshot = {
                    ...s,
                    state: "hover",
                    focusedHeroId: nextFocused,
                    hoverHeroId: null,
                    carouselHeroIds: buildCarousel(this.pool, this.excluded, nextFocused, this.windowSize, this.random),
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
    carouselWindow,
}: UseFakeDraftControllerOptions): FakeDraftSnapshot => {
    // useState's lazy initializer (not useRef) is the sanctioned way to
    // construct an expensive, stable object once - reading ref.current during
    // render is disallowed by the react-hooks/refs rule.
    const [controller] = useState(
        () => new FakeDraftController({ heroPool, excludedHeroIds, random, carouselWindow })
    );
    const [snapshot, setSnapshot] = useState(controller.snapshot);

    useEffect(() => {
        controller.updateExclusions(excludedHeroIds);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [excludedHeroIds.join(",")]);

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
