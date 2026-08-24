import { useEffect, type SyntheticEvent } from "react";
import { getHeroById } from "@/entities/dota-hero/lib/search";
import type { StreamMatch } from "@/entities/stream-session/model/types";
import type {
    OverlayAnchor,
    RecentMatchesSettings,
} from "@/entities/stream-overlay-layout/model/types";
import { growDirectionForAnchor } from "@/entities/stream-overlay-layout/lib/grow-direction";
import styles from "./widget.module.scss";

interface RecentMatchesProps {
    matches: StreamMatch[];
    settings: RecentMatchesSettings;
    // Направление роста списка больше не хранится в settings - вычисляется
    // из anchor'а самого виджета (см. задачу, п.3): top-* растёт вниз,
    // bottom-* растёт вверх, center-* вниз как самый предсказуемый вариант.
    anchor: OverlayAnchor;
}

// ABANDON - собственное значение result (не флаг поверх loss, см. задачу:
// "в истории отображать ABANDON, а не одновременно LOSS · ABANDON") - поэтому
// одна и та же тройная развилка используется и для цвета, и для метки, без
// отдельного is-abandon-флага рядом с result.
const RESULT_CLASS_NAME: Record<NonNullable<StreamMatch["result"]>, string> = {
    win: styles.matchResultWin,
    loss: styles.matchResultLoss,
    abandon: styles.matchResultAbandon,
};

// W/L остаётся отдельным коротким элементом (см. задачу) - одна буква на
// оба режима, отдельный "подробный" вариант с полным словом убран вместе с
// именем героя в строке. result может быть null только у needs_review
// (backend controllers/stream/overlay.ts отдаёт сюда только "finalized"
// матчи, так что на практике это не встречается - но тип честно допускает
// null, поэтому рендер ниже защищается заглушкой).
const RESULT_LABEL: Record<NonNullable<StreamMatch["result"]>, string> = {
    win: "W",
    loss: "L",
    abandon: "A",
};

interface MatchRowProps {
    match: StreamMatch;
    // Порядковый номер строки в видимом окне лога, не id матча (см. задачу:
    // "номер матча" как первый элемент строки).
    index: number;
}

// Единый компакт-состав строки для ЛЮБОГО значения settings.compact (см.
// задачу: "убрать имя героя во всех вариантах отображения, а не только в
// compact-режиме") - номер → портрет героя (28-32px) → KDA → W/L. Имя героя
// нигде в видимой строке не рендерится, остаётся только в title/alt/
// aria-label портрета для доступности.
const MatchRow = ({ match, index }: MatchRowProps) => {
    const hero = getHeroById(match.heroId);
    const heroTitle = hero?.localizedName ?? `Hero ${match.heroId}`;
    const hideBrokenIcon = (event: SyntheticEvent<HTMLImageElement>) => {
        event.currentTarget.style.visibility = "hidden";
    };

    return (
        <div className={styles.matchRow}>
            <span className={styles.matchIndex}>{index}</span>
            <img
                src={hero?.imageUrl}
                alt={heroTitle}
                title={heroTitle}
                aria-label={heroTitle}
                className={styles.heroIconTiny}
                onError={hideBrokenIcon}
            />
            <span className={styles.matchKda}>
                {match.kills}/{match.deaths}/{match.assists}
            </span>
            <span className={match.result ? RESULT_CLASS_NAME[match.result] : undefined}>
                {match.result ? RESULT_LABEL[match.result] : "—"}
            </span>
        </div>
    );
};

// Overlay-виджет истории намеренно показывает только settings.limit
// последних матчей, а не всю сессию целиком (см. задачу, п.7 - стример
// может сыграть 15-20 матчей за сессию, весь список одной колонкой не
// поместится и не нужен - полная редактируемая история уже есть на
// странице настроек, entities/stream-session + match-history-panel.tsx).
// Итоговый W/L сессии показывает SessionStats, не этот виджет - обрезка
// истории на него не влияет.
export const RecentMatches = ({ matches, settings, anchor }: RecentMatchesProps) => {
    // matches уже приходят newest-first (ORDER BY ended_at DESC на бэкенде) -
    // "oldest-first" просто разворачивает порядок данных; growDirection ниже
    // отдельно управляет тем, в какую сторону визуально растёт список.
    const ordered =
        settings.direction === "oldest-first" ? [...matches].slice().reverse() : matches;
    const visible = ordered.slice(0, settings.limit);
    const overflowCount = Math.max(0, ordered.length - settings.limit);

    const growDirection = growDirectionForAnchor(anchor);

    useEffect(() => {
        console.info("[WK-68][Recent Games]", {
            source: settings.source,
            configuredLimit: settings.limit,
            receivedMatches: matches.length,
            renderedMatches: visible.length,
            overflowMatches: overflowCount,
            anchor,
            growDirection,
        });
    }, [
        anchor,
        growDirection,
        matches.length,
        overflowCount,
        settings.limit,
        settings.source,
        visible.length,
    ]);

    const listClassName =
        growDirection === "up"
            ? `${styles.matchesList} ${styles.matchesListGrowUp}`
            : `${styles.matchesList} ${styles.matchesListGrowDown}`;

    const overflowIndicator = overflowCount > 0 && (
        <div className={styles.matchesOverflow}>+{overflowCount} ещё</div>
    );

    // Задача (WK-100): 0 матчей за текущий стрим - секция не должна
    // рендериться вообще (ни пустая карточка, ни "нет матчей", ни
    // декоративный placeholder), а не просто показывать другой текст внутри
    // того же card. Появляется автоматически с первым завершённым матчем -
    // `matches` уже реактивно приходит из overlay poll, отдельного триггера
    // не нужно. AnchoredWidget оборачивает это в абсолютно позиционированный
    // блок (см. overlay/index.tsx) - null здесь просто ничего не занимает.
    if (matches.length === 0) return null;

    return (
        <div className={styles.card}>
            {/* growDirection="up" - более старые (обрезанные) матчи
                концептуально "выше" видимого окна, поэтому индикатор сверху;
                growDirection="down" - соответственно снизу. */}
            {growDirection === "up" && overflowIndicator}
            <div className={listClassName}>
                {visible.map((match, i) => (
                    <MatchRow key={match.id} match={match} index={i + 1} />
                ))}
            </div>
            {growDirection === "down" && overflowIndicator}
        </div>
    );
};
