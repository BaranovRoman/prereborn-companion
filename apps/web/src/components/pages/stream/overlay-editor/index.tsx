"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Alert, Button, Collapse, InputNumber, Segmented, Slider, Switch, Upload, message } from "antd";
import type { CollapseProps } from "antd";
import { useStreamSession } from "@/entities/stream-user/lib/use-stream-session";
import { usePageReady } from "@/shared/ui/route-transition/usePageReady";
import { streamOverlayLayoutApi } from "@/entities/stream-overlay-layout/api/stream-overlay-layout";
import { DEFAULT_OVERLAY_LAYOUT } from "@/entities/stream-overlay-layout/model/default-layout";
import { normalizeOverlayLayout } from "@/entities/stream-overlay-layout/model/normalize-layout";
import {
    OVERLAY_ASPECT_RATIO_PRESETS,
    OVERLAY_WIDGET_IDS,
    RECENT_MATCHES_LIMIT_MIN,
    RECENT_MATCHES_LIMIT_MAX,
    SAFE_AREA_PERCENT,
    type OverlayAnchor,
    type OverlayAspectRatio,
    type OverlayAspectRatioPreset,
    type OverlayLayout,
    type ConfigurableBroadcastSceneId,
    type OverlayWidgetId,
    type OverlayWidgetLayout,
    type RecentMatchesSettings,
} from "@/entities/stream-overlay-layout/model/types";
import { computeSceneDimensions } from "@/entities/stream-overlay-layout/lib/scene-dimensions";
import { anchorFraction, splitAnchor } from "@/entities/stream-overlay-layout/lib/anchor";
import { OverlayCanvas } from "@/components/pages/overlay/overlay-canvas";
import type { ReferenceBackgroundImage } from "@/components/pages/overlay/game-ui-reference-layer";
import {
    AnchoredWidget,
    type SnapGuideState,
    type WidgetBounds,
} from "@/components/pages/overlay/anchored-widget";
import { SessionStats } from "@/components/pages/overlay/widgets/session-stats";
import { CurrentGame } from "@/components/pages/overlay/widgets/current-game";
import { RecentMatches } from "@/components/pages/overlay/widgets/recent-matches";
import { AnchorGrid } from "./anchor-grid";
import { OVERLAY_LAYOUT_PRESETS } from "./presets";
import { useReferenceBackground } from "./use-reference-background";
import { CameraZoneEditor } from "./camera-zone-editor";
import {
    PREVIEW_SESSION,
    PREVIEW_LAST_HERO_ID,
    PREVIEW_MATCHES,
    PREVIEW_GAME_MODE,
} from "./preview-data";
import styles from "./index.module.scss";

// Пресеты временно скрыты из UI (см. задачу) - данные (presets.ts) и логика
// применения (applyPreset ниже) намеренно не тронуты, чтобы вернуть фичу
// одной строкой.
const SHOW_PRESETS = false;

// Строка лога матчей теперь всегда рендерится одинаково независимо от
// settings.compact (см. widgets/recent-matches.tsx - имя героя убрано из
// строки во ВСЕХ вариантах отображения, а не только в compact-режиме, так
// что разница между "Компактный"/"Подробный" исчезла). Сам переключатель и
// поле compact в RecentMatchesSettings не трогаем - только прячем из UI,
// чтобы не показывать управление без видимого эффекта.
const SHOW_COMPACT_MODE_TOGGLE = false;
const VISIBLE_OVERLAY_WIDGET_IDS = OVERLAY_WIDGET_IDS.filter(
    (id) => id !== "companionStatus"
);

const SCALE_OPTIONS = [
    { label: "75%", value: 0.75 },
    { label: "100%", value: 1 },
    { label: "125%", value: 1.25 },
    { label: "150%", value: 1.5 },
];

const DIRECTION_OPTIONS = [
    { label: "Новые сверху", value: "newest-first" as const },
    { label: "Старые сверху", value: "oldest-first" as const },
];

const CORNER_OPTIONS = [
    { label: "↖", value: "top-left" },
    { label: "↗", value: "top-right" },
    { label: "↙", value: "bottom-left" },
    { label: "↘", value: "bottom-right" },
] as const;
const MINIMAP_PRESET_OPTIONS = [
    { label: "Чистая", value: "clean" },
    { label: "Dotabod", value: "random-a" },
    { label: "Случайная B", value: "random-b" },
    { label: "Плотная", value: "random-dense" },
    { label: "Интерактив", value: "interactive" },
] as const;

// Готовые пары ratio для всех пресетов кроме "custom" - выбор пресета в UI
// сразу подставляет числа, "custom" оставляет то, что пользователь ввёл сам.
const ASPECT_RATIO_PRESET_VALUES: Record<
    Exclude<OverlayAspectRatioPreset, "custom">,
    { widthRatio: number; heightRatio: number }
> = {
    "16:9": { widthRatio: 16, heightRatio: 9 },
    "16:10": { widthRatio: 16, heightRatio: 10 },
    "21:9": { widthRatio: 21, heightRatio: 9 },
    "32:9": { widthRatio: 32, heightRatio: 9 },
    "4:3": { widthRatio: 4, heightRatio: 3 },
};

const ASPECT_RATIO_OPTIONS = OVERLAY_ASPECT_RATIO_PRESETS.map((preset) => ({
    label: preset === "custom" ? "Другое" : preset,
    value: preset,
}));

// Насколько соотношению сторон изображения/сцены разрешено отличаться от
// табличного пресета, чтобы всё равно считать их совпадающими (реальные
// скриншоты почти никогда не дают идеально точное 16/9 из-за округления px).
const ASPECT_RATIO_TOLERANCE = 0.015;

const ratiosMatch = (a: number, b: number): boolean => Math.abs(a - b) / a <= ASPECT_RATIO_TOLERANCE;

// Пытается опознать "круглый" формат загруженного скриншота (см. задачу:
// "Скриншот имеет формат 16:9. Переключить сцену на 16:9?") - подсказка
// имеет смысл только для табличных пресетов, произвольные "grubby" ratio
// вроде 1897:1073 не предлагаем, чтобы не плодить лишний custom-шум.
const matchAspectRatioPreset = (
    naturalWidth: number,
    naturalHeight: number
): Exclude<OverlayAspectRatioPreset, "custom"> | null => {
    const imageRatio = naturalWidth / naturalHeight;
    for (const preset of Object.keys(ASPECT_RATIO_PRESET_VALUES) as Array<
        Exclude<OverlayAspectRatioPreset, "custom">
    >) {
        const { widthRatio, heightRatio } = ASPECT_RATIO_PRESET_VALUES[preset];
        if (ratiosMatch(widthRatio / heightRatio, imageRatio)) return preset;
    }
    return null;
};

const clampNumber = (value: number, min: number, max: number): number =>
    Math.min(Math.max(value, min), max);

// Один раз пересчитывает xVw/yVh всех виджетов под НОВЫЕ размеры сцены,
// используя их ПОСЛЕДНИЙ измеренный bounding box (см. задачу, п.7 - "если
// виджет оказался за границей из-за более узкого формата, нормализовать").
// bounds.width/height не зависят от сцены (это отрендеренный размер контента
// + widget.scale) - меняется только сама сцена, поэтому её достаточно взять
// как есть и просто заново вписать в новые границы, зеркаля клэмп из
// anchored-widget.tsx (там это происходит при drag, здесь - разово).
const normalizeWidgetForScene = (
    widget: OverlayWidgetLayout,
    bounds: WidgetBounds | undefined,
    sceneWidth: number,
    sceneHeight: number
): Partial<OverlayWidgetLayout> => {
    if (!bounds) return {};
    const frac = anchorFraction(widget.anchor);
    const anchorPointX = (widget.xVw / 100) * sceneWidth;
    const anchorPointY = (widget.yVh / 100) * sceneHeight;

    const rawLeft = anchorPointX - frac.x * bounds.width;
    const rawTop = anchorPointY - frac.y * bounds.height;

    const left = clampNumber(rawLeft, 0, Math.max(0, sceneWidth - bounds.width));
    const top = clampNumber(rawTop, 0, Math.max(0, sceneHeight - bounds.height));

    if (left === rawLeft && top === rawTop) return {};

    return {
        xVw: ((left + frac.x * bounds.width) / sceneWidth) * 100,
        yVh: ((top + frac.y * bounds.height) / sceneHeight) * 100,
    };
};

const WIDGET_LABELS: Record<OverlayWidgetId, string> = {
    session: "Рейтинг и W/L",
    currentGame: "Текущий герой",
    recentMatches: "История матчей",
    companionStatus: "Статус companion",
};

// Конфигуратор раскладки - превью рендерит РЕАЛЬНЫЕ overlay-виджеты
// (components/pages/overlay/widgets/*) с тестовыми данными (preview-data.ts)
// через ТОТ ЖЕ OverlayCanvas + AnchoredWidget, что и настоящий
// /overlay/:token. Anchor меняется только вручную (сетка 3x3) или пресетом -
// drag/snapping трогают исключительно координаты (см. задачу, п.1). Ничего
// не сохраняется на backend, пока пользователь не нажмёт "Сохранить".
export const OverlayEditorPage = () => {
    const router = useRouter();
    const { user: sessionUser, loading } = useStreamSession();
    const [layout, setLayout] = useState<OverlayLayout>(DEFAULT_OVERLAY_LAYOUT);
    const [selectedScene, setSelectedScene] =
        useState<ConfigurableBroadcastSceneId>("gameplay");
    const [layoutLoading, setLayoutLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [showSafeArea, setShowSafeArea] = useState(true);
    const [snapGuides, setSnapGuides] = useState<SnapGuideState>({
        x: null,
        y: null,
    });
    const [widgetBounds, setWidgetBounds] = useState<
        Partial<Record<OverlayWidgetId, WidgetBounds>>
    >({});
    const [messageApi, contextHolder] = message.useMessage();
    const lastSavedRef = useRef<OverlayLayout>(DEFAULT_OVERLAY_LAYOUT);
    const referenceBackground = useReferenceBackground();

    const { ready } = usePageReady(600);
    useEffect(() => {
        ready();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (!loading && !sessionUser) {
            router.replace("/stream/login");
        }
    }, [loading, sessionUser, router]);

    useEffect(() => {
        let cancelled = false;
        streamOverlayLayoutApi
            .get()
            .then((loaded) => {
                if (!cancelled) {
                    const normalized = normalizeOverlayLayout(loaded);
                    setLayout(normalized);
                    lastSavedRef.current = normalized;
                }
            })
            .catch(() => {
                // Оставляем DEFAULT_OVERLAY_LAYOUT как рабочий фолбэк.
            })
            .finally(() => {
                if (!cancelled) setLayoutLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const dirty = JSON.stringify(layout) !== JSON.stringify(lastSavedRef.current);
    const activeSceneLayout = layout.scenes[selectedScene];
    const sceneDimensions = computeSceneDimensions(layout.aspectRatio);

    const referenceBackgroundImage: ReferenceBackgroundImage | null =
        referenceBackground.imageUrl && referenceBackground.record
            ? { url: referenceBackground.imageUrl, opacity: referenceBackground.record.opacity }
            : null;
    const referenceAspectRatioMismatch =
        referenceBackground.record !== null &&
        !ratiosMatch(
            layout.aspectRatio.widthRatio / layout.aspectRatio.heightRatio,
            referenceBackground.record.naturalWidth / referenceBackground.record.naturalHeight
        );
    const suggestedAspectRatioPreset =
        referenceBackground.record && referenceAspectRatioMismatch
            ? matchAspectRatioPreset(
                  referenceBackground.record.naturalWidth,
                  referenceBackground.record.naturalHeight
              )
            : null;

    const updateSceneWidgets = (
        updater: (widgets: typeof activeSceneLayout.widgets) => typeof activeSceneLayout.widgets
    ) =>
        setLayout((c) => ({
            ...c,
            scenes: {
                ...c.scenes,
                [selectedScene]: {
                    ...c.scenes[selectedScene],
                    widgets: updater(c.scenes[selectedScene].widgets),
                },
            },
        }));
    const updateSession = (patch: Partial<OverlayWidgetLayout>) =>
        updateSceneWidgets((widgets) => ({
            ...widgets,
            session: { ...widgets.session, ...patch },
        }));
    const updateCurrentGame = (patch: Partial<OverlayWidgetLayout>) =>
        updateSceneWidgets((widgets) => ({
            ...widgets,
            currentGame: { ...widgets.currentGame, ...patch },
        }));
    const updateCompanionStatus = (patch: Partial<OverlayWidgetLayout>) =>
        updateSceneWidgets((widgets) => ({
            ...widgets,
            companionStatus: { ...widgets.companionStatus, ...patch },
        }));
    const updateRecentMatches = (patch: Partial<OverlayWidgetLayout>) =>
        updateSceneWidgets((widgets) => ({
            ...widgets,
            recentMatches: { ...widgets.recentMatches, ...patch },
        }));
    const updateRecentMatchesSettings = (patch: Partial<RecentMatchesSettings>) =>
        updateSceneWidgets((widgets) => ({
            ...widgets,
                recentMatches: {
                    ...widgets.recentMatches,
                    recentMatches: {
                        ...widgets.recentMatches.recentMatches,
                        ...patch,
                    },
                },
        }));
    const updateCameraZone = (
        patch: Partial<typeof activeSceneLayout.cameraZone>
    ) =>
        setLayout((c) => ({
            ...c,
            scenes: {
                ...c.scenes,
                [selectedScene]: {
                    ...c.scenes[selectedScene],
                    cameraZone: {
                        ...c.scenes[selectedScene].cameraZone,
                        ...patch,
                    },
                },
            },
        }));
    const updateMinimapCover = (
        patch: Partial<typeof activeSceneLayout.minimapCover>
    ) =>
        setLayout((c) => ({
            ...c,
            scenes: {
                ...c.scenes,
                [selectedScene]: {
                    ...c.scenes[selectedScene],
                    minimapCover: {
                        ...c.scenes[selectedScene].minimapCover,
                        ...patch,
                    },
                },
            },
        }));
    const changeCameraAnchor = (anchor: typeof activeSceneLayout.cameraZone.anchor) => {
        const zone = activeSceneLayout.cameraZone;
        const oldFraction = anchorFraction(zone.anchor);
        const newFraction = anchorFraction(anchor);
        const left = zone.x - oldFraction.x * zone.width;
        const top = zone.y - oldFraction.y * zone.height;
        updateCameraZone({
            anchor,
            x: left + newFraction.x * zone.width,
            y: top + newFraction.y * zone.height,
        });
    };

    const updaters: Record<
        OverlayWidgetId,
        (patch: Partial<OverlayWidgetLayout>) => void
    > = {
        session: updateSession,
        currentGame: updateCurrentGame,
        recentMatches: updateRecentMatches,
        companionStatus: updateCompanionStatus,
    };

    // Ручная смена anchor через сетку 3x3 не должна визуально сдвигать
    // виджет (см. задачу, п.2): берём его ТЕКУЩИЙ измеренный bounding box
    // (репортится всеми виджетами через onBoundsChange независимо от drag),
    // вычисляем, где на этом же боксе сидит НОВАЯ anchor-точка, и
    // пересчитываем xVw/yVh так, чтобы бокс остался на месте - меняется
    // только то, относительно чего он будет расти/масштабироваться дальше.
    const changeAnchor = (id: OverlayWidgetId, newAnchor: OverlayAnchor) => {
        const bounds = widgetBounds[id];
        if (!bounds) {
            updaters[id]({ anchor: newAnchor });
            return;
        }
        const frac = anchorFraction(newAnchor);
        const anchorPointX = bounds.left + frac.x * bounds.width;
        const anchorPointY = bounds.top + frac.y * bounds.height;
        updaters[id]({
            anchor: newAnchor,
            xVw: (anchorPointX / sceneDimensions.width) * 100,
            yVh: (anchorPointY / sceneDimensions.height) * 100,
        });
    };

    // "Привязать к безопасной зоне" - выравнивает anchor-точку виджета по
    // линии safe area на тех осях, где anchor не "center". Anchor-точка САМА
    // и есть нужный край (если anchor="bottom-right", это уже правый нижний
    // угол) - измерять размер виджета для этого не нужно.
    const snapToSafeArea = (id: OverlayWidgetId) => {
        const widget = activeSceneLayout.widgets[id];
        const { x, y } = splitAnchor(widget.anchor);
        const xVw =
            x === "center" ? widget.xVw : x === "left" ? SAFE_AREA_PERCENT : 100 - SAFE_AREA_PERCENT;
        const yVh =
            y === "center" ? widget.yVh : y === "top" ? SAFE_AREA_PERCENT : 100 - SAFE_AREA_PERCENT;
        updaters[id]({ xVw, yVh });
    };

    const applyPreset = (presetId: string) => {
        const preset = OVERLAY_LAYOUT_PRESETS.find((p) => p.id === presetId);
        if (!preset) return;
        // Пресеты задают только widgets - текущий выбранный aspectRatio
        // сохраняется (см. задачу, п.8: "presets работают на всех форматах").
        setLayout((c) => ({
            ...c,
            scenes: { ...c.scenes, [selectedScene]: preset.layout },
        }));
    };

    // Смена aspect ratio - позиции остаются процентами сцены (см. задачу,
    // п.7: "anchors не менять"), поэтому сама смена уже "реflow"-ит раскладку
    // бесплатно. Единственный реальный риск - виджет, чей измеренный
    // bounding box вылезает за новую (обычно более узкую по высоте) сцену -
    // normalizeWidgetForScene возвращает пустой патч, если виджет и так
    // помещается, поэтому лишний setLayout не создаёт видимого дрожания.
    const applyAspectRatio = (aspectRatio: OverlayAspectRatio) => {
        const { width: nextWidth, height: nextHeight } =
            computeSceneDimensions(aspectRatio);
        const normalize = (widget: OverlayWidgetLayout, id: OverlayWidgetId) => ({
            ...widget,
            ...normalizeWidgetForScene(widget, widgetBounds[id], nextWidth, nextHeight),
        });

        setLayout((c) => ({
            ...c,
            aspectRatio,
            scenes: { ...c.scenes, [selectedScene]: { ...c.scenes[selectedScene], widgets: {
                session: normalize(c.scenes[selectedScene].widgets.session, "session"),
                currentGame: normalize(c.scenes[selectedScene].widgets.currentGame, "currentGame"),
                recentMatches: {
                    ...normalize(c.scenes[selectedScene].widgets.recentMatches, "recentMatches"),
                    recentMatches: c.scenes[selectedScene].widgets.recentMatches.recentMatches,
                },
                companionStatus: normalize(c.scenes[selectedScene].widgets.companionStatus, "companionStatus"),
            }}},
        }));
    };

    const handlePresetRatioChange = (preset: OverlayAspectRatioPreset) => {
        if (preset === "custom") {
            applyAspectRatio({ ...layout.aspectRatio, preset });
            return;
        }
        applyAspectRatio({ ...layout.aspectRatio, preset, ...ASPECT_RATIO_PRESET_VALUES[preset] });
    };

    const handleCustomRatioChange = (
        field: "widthRatio" | "heightRatio",
        value: number
    ) => {
        applyAspectRatio({ ...layout.aspectRatio, [field]: value });
    };

    const handleResolutionChange = (field: "width" | "height", value: number) => {
        applyAspectRatio({ ...layout.aspectRatio, [field]: value });
    };

    const handleReset = () => setLayout(DEFAULT_OVERLAY_LAYOUT);

    const handleSave = async () => {
        setSaving(true);
        try {
            const saved = await streamOverlayLayoutApi.put(layout);
            setLayout(saved);
            lastSavedRef.current = saved;
            messageApi.success("Раскладка сохранена");
        } catch {
            messageApi.error("Не удалось сохранить раскладку");
        } finally {
            setSaving(false);
        }
    };

    if (loading || !sessionUser || layoutLoading) {
        return <div className={styles.loading}>Загрузка…</div>;
    }

    const recentMatchesSettings = activeSceneLayout.widgets.recentMatches.recentMatches;

    const otherBoundsFor = (id: OverlayWidgetId): WidgetBounds[] =>
        OVERLAY_WIDGET_IDS.filter((otherId) => otherId !== id)
            .map((otherId) => widgetBounds[otherId])
            .filter((bounds): bounds is WidgetBounds => Boolean(bounds));

    const renderWidgetContent = (id: OverlayWidgetId) => {
        switch (id) {
            case "session":
                return (
                    <SessionStats
                        rating={PREVIEW_SESSION.rating}
                        sessionRatingDelta={PREVIEW_SESSION.sessionRatingDelta}
                        wins={PREVIEW_SESSION.wins}
                        losses={PREVIEW_SESSION.losses}
                        gameMode={PREVIEW_GAME_MODE}
                    />
                );
            case "currentGame":
                return <CurrentGame lastHeroId={PREVIEW_LAST_HERO_ID} />;
            case "recentMatches":
                return (
                    <RecentMatches
                        matches={PREVIEW_MATCHES}
                        settings={recentMatchesSettings}
                        anchor={activeSceneLayout.widgets.recentMatches.anchor}
                    />
                );
            case "companionStatus":
                return null;
        }
    };

    const collapseItems: CollapseProps["items"] = VISIBLE_OVERLAY_WIDGET_IDS.map((id) => {
        const widget = activeSceneLayout.widgets[id];
        return {
            key: id,
            label: (
                <div className={styles.collapseHeader}>
                    <span className={styles.collapseHeaderTitle}>
                        {WIDGET_LABELS[id]}
                    </span>
                    <Switch
                        checked={widget.visible}
                        checkedChildren="Показан"
                        unCheckedChildren="Скрыт"
                        onClick={(_checked, event) => event.stopPropagation()}
                        onChange={(visible) => updaters[id]({ visible })}
                    />
                </div>
            ),
            children: (
                <div className={styles.widgetBody}>
                    <div className={styles.settingsRow}>
                        <span className={styles.settingsRowLabel}>Anchor</span>
                        <AnchorGrid
                            value={widget.anchor}
                            onChange={(anchor) => changeAnchor(id, anchor)}
                        />
                        <Button size="small" onClick={() => snapToSafeArea(id)}>
                            Привязать к безопасной зоне
                        </Button>
                    </div>
                    <div className={styles.settingsRow}>
                        <span className={styles.settingsRowLabel}>Масштаб</span>
                        <Segmented
                            size="small"
                            value={widget.scale}
                            options={SCALE_OPTIONS}
                            onChange={(scale) => updaters[id]({ scale })}
                        />
                    </div>

                    {id === "recentMatches" && (
                        <div className={styles.recentMatchesSettings}>
                            <div className={styles.settingsRow}>
                                <span className={styles.settingsRowLabel}>
                                    Количество матчей
                                </span>
                                <InputNumber
                                    className={styles.limitStepper}
                                    size="small"
                                    min={RECENT_MATCHES_LIMIT_MIN}
                                    max={RECENT_MATCHES_LIMIT_MAX}
                                    step={1}
                                    precision={0}
                                    value={recentMatchesSettings.limit}
                                    onChange={(value) => {
                                        if (value === null || Number.isNaN(value)) return;
                                        updateRecentMatchesSettings({
                                            limit: Math.round(value),
                                        });
                                    }}
                                />
                            </div>
                            {SHOW_COMPACT_MODE_TOGGLE && (
                                <div className={styles.settingsRow}>
                                    <span className={styles.settingsRowLabel}>Режим</span>
                                    <Switch
                                        size="small"
                                        checked={recentMatchesSettings.compact}
                                        checkedChildren="Компактный"
                                        unCheckedChildren="Подробный"
                                        onChange={(compact) =>
                                            updateRecentMatchesSettings({ compact })
                                        }
                                    />
                                </div>
                            )}
                            <div className={styles.settingsRow}>
                                <span className={styles.settingsRowLabel}>Порядок</span>
                                <Segmented
                                    size="small"
                                    value={recentMatchesSettings.direction}
                                    options={DIRECTION_OPTIONS}
                                    onChange={(direction) =>
                                        updateRecentMatchesSettings({ direction })
                                    }
                                />
                            </div>
                        </div>
                    )}
                </div>
            ),
        };
    });

    return (
        <div className={styles.page}>
            {contextHolder}
            <div className={styles.card}>
                <div className={styles.header}>
                    <h1 className={styles.title}>Раскладка оверлея</h1>
                    <Link href="/stream">← Назад в настройки</Link>
                </div>
                <Segmented
                    className={styles.sceneTabs}
                    value={selectedScene}
                    options={[
                        { label: "Драфт", value: "draft" },
                        { label: "Игра", value: "gameplay" },
                    ]}
                    onChange={(value) =>
                        setSelectedScene(value as ConfigurableBroadcastSceneId)
                    }
                />
                <div className={styles.betweenMatchesNote}>
                    <strong>Между матчами</strong>
                    <span>
                        До и после игры показывается текущий полноэкранный экран ожидания.
                        Его содержимое настраивается на дашборде.
                    </span>
                    <Link href="/stream">Настроить экран</Link>
                </div>
                <div className={styles.hint}>
                    Перетаскивайте блоки внутри превью - масштаб и пропорции
                    полностью совпадают с тем, что покажет OBS. Изменения
                    применятся к активному overlay только после сохранения.
                </div>

                {SHOW_PRESETS && (
                    <div className={styles.presetsSection}>
                        <div className={styles.sectionTitle}>Готовые раскладки</div>
                        <div className={styles.presetButtons}>
                            {OVERLAY_LAYOUT_PRESETS.map((preset) => (
                                <Button key={preset.id} onClick={() => applyPreset(preset.id)}>
                                    {preset.label}
                                </Button>
                            ))}
                        </div>
                    </div>
                )}

                <details className={styles.advancedSection}>
                    <summary>Дополнительно: пропорции сцены</summary>
                    <div className={styles.advancedSectionBody}>
                    <Segmented
                        value={layout.aspectRatio.preset}
                        options={ASPECT_RATIO_OPTIONS}
                        onChange={handlePresetRatioChange}
                    />
                    {layout.aspectRatio.preset === "custom" && (
                        <div className={styles.settingsRow}>
                            <InputNumber
                                size="small"
                                min={1}
                                precision={0}
                                value={layout.aspectRatio.widthRatio}
                                onChange={(value) =>
                                    value !== null &&
                                    handleCustomRatioChange("widthRatio", value)
                                }
                            />
                            <span>:</span>
                            <InputNumber
                                size="small"
                                min={1}
                                precision={0}
                                value={layout.aspectRatio.heightRatio}
                                onChange={(value) =>
                                    value !== null &&
                                    handleCustomRatioChange("heightRatio", value)
                                }
                            />
                        </div>
                    )}
                    <div className={styles.settingsRow}>
                        <label>
                            <span>Ширина OBS, px</span>
                            <InputNumber min={640} max={7680} precision={0} value={layout.aspectRatio.width} onChange={(value) => value !== null && handleResolutionChange("width", value)} />
                        </label>
                        <label>
                            <span>Высота OBS, px</span>
                            <InputNumber min={360} max={4320} precision={0} value={layout.aspectRatio.height} onChange={(value) => value !== null && handleResolutionChange("height", value)} />
                        </label>
                    </div>
                </div>
                </details>

                <div className={styles.editorGrid}>
                <aside className={styles.settingsColumn}>
                <div className={styles.presetsSection}>
                    <div className={styles.sectionTitle}>Фон для примерки</div>
                    <div className={styles.hint}>
                        Загрузите скриншот игры, чтобы точнее сверить расстановку
                        виджетов с реальным HUD - виден только здесь, в редакторе,
                        и никогда не попадает в публичный overlay.
                    </div>
                    <div className={styles.referenceControls}>
                        <Upload
                            accept="image/png,image/jpeg,image/webp"
                            showUploadList={false}
                            beforeUpload={(file) => {
                                void referenceBackground.upload(file);
                                return false;
                            }}
                        >
                            <Button size="small">
                                {referenceBackground.record ? "Заменить" : "Загрузить"}
                            </Button>
                        </Upload>
                        {referenceBackground.record && (
                            <Button
                                size="small"
                                danger
                                onClick={() => void referenceBackground.remove()}
                            >
                                Удалить
                            </Button>
                        )}
                        {referenceBackground.record && (
                            <span className={styles.referenceFileName}>
                                {referenceBackground.record.fileName}
                            </span>
                        )}
                    </div>
                    {referenceBackground.error && (
                        <Alert
                            type="error"
                            showIcon
                            className={styles.referenceAlert}
                            message={referenceBackground.error}
                        />
                    )}
                    {referenceBackground.record && (
                        <div className={styles.settingsRow}>
                            <span className={styles.settingsRowLabel}>Прозрачность</span>
                            <Slider
                                className={styles.opacitySlider}
                                min={10}
                                max={100}
                                value={Math.round(referenceBackground.record.opacity * 100)}
                                onChange={(value) => referenceBackground.setOpacity(value / 100)}
                            />
                            <span className={styles.opacityValue}>
                                {Math.round(referenceBackground.record.opacity * 100)}%
                            </span>
                        </div>
                    )}
                    {referenceAspectRatioMismatch && (
                        <Alert
                            type="warning"
                            showIcon
                            className={styles.referenceAlert}
                            message="Соотношение сторон скриншота отличается от сцены - для точного совпадения рекомендуется использовать одинаковый aspect ratio."
                        />
                    )}
                    {suggestedAspectRatioPreset && (
                        <div className={styles.referenceSuggestion}>
                            <span>
                                Скриншот имеет формат {suggestedAspectRatioPreset}.
                            </span>
                            <Button
                                size="small"
                                onClick={() => handlePresetRatioChange(suggestedAspectRatioPreset)}
                            >
                                Переключить сцену на {suggestedAspectRatioPreset}
                            </Button>
                        </div>
                    )}
                </div>

                <div className={styles.cameraSection}>
                    <div className={styles.cameraSectionHeader}>
                        <div>
                            <div className={styles.sectionTitle}>Камера в OBS</div>
                            <div className={styles.cameraHint}>
                                Только ориентир в редакторе: камера остаётся отдельным
                                источником OBS и не выводится нашим оверлеем.
                            </div>
                        </div>
                        <Switch
                            checked={activeSceneLayout.cameraZone.enabled}
                            onChange={(enabled) => updateCameraZone({ enabled })}
                        />
                    </div>
                    {activeSceneLayout.cameraZone.enabled && (
                        <div className={styles.widgetBody}>
                            <label>
                                <span>Точка выравнивания</span>
                                <AnchorGrid
                                    value={activeSceneLayout.cameraZone.anchor}
                                    onChange={changeCameraAnchor}
                                />
                            </label>
                            <div className={styles.cameraFields}>
                            {([
                                ["x", "Позиция X"],
                                ["y", "Позиция Y"],
                                ["width", "Ширина"],
                                ["height", "Высота"],
                            ] as const).map(([field, label]) => (
                                <label key={field}>
                                    <span>{label}, px</span>
                                    <InputNumber
                                        min={field === "width" || field === "height" ? 80 : 0}
                                        max={field === "x" || field === "width" ? sceneDimensions.width : sceneDimensions.height}
                                        value={activeSceneLayout.cameraZone[field]}
                                        onChange={(value) =>
                                            value !== null &&
                                            updateCameraZone({ [field]: value })
                                        }
                                    />
                                </label>
                            ))}
                            </div>
                        </div>
                    )}
                    </div>
                <div className={styles.cameraSection}>
                    <div className={styles.cameraSectionHeader}>
                        <div>
                            <div className={styles.sectionTitle}>Перекрытие миникарты</div>
                            <div className={styles.cameraHint}>Настраивается отдельно для каждой сцены.</div>
                        </div>
                        <Switch checked={activeSceneLayout.minimapCover.enabled} onChange={(enabled) => updateMinimapCover({ enabled })} />
                    </div>
                    {activeSceneLayout.minimapCover.enabled && (
                        <div className={styles.widgetBody}>
                            <label><span>Вариант</span><Segmented options={[...MINIMAP_PRESET_OPTIONS]} value={activeSceneLayout.minimapCover.preset} onChange={(preset) => updateMinimapCover({ preset })} /></label>
                            <label><span>Угол привязки</span><Segmented options={[...CORNER_OPTIONS]} value={activeSceneLayout.minimapCover.anchor} onChange={(anchor) => updateMinimapCover({ anchor })} /></label>
                            <div className={styles.cameraFields}>
                                {([ ["x", "Отступ X"], ["y", "Отступ Y"], ["size", "Размер"] ] as const).map(([field, label]) => (
                                    <label key={field}>
                                        <span>{label}, px</span>
                                        <InputNumber min={0} max={field === "size" ? 600 : 1920} value={activeSceneLayout.minimapCover[field]} onChange={(value) => value !== null && updateMinimapCover({ [field]: value })} />
                                    </label>
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                <div className={styles.controls}>
                    <Collapse items={collapseItems} defaultActiveKey={[]} />
                </div>
                </aside>

                <div className={styles.previewColumn}>
                <div className={styles.sceneTools}>
                    <Switch checked={showSafeArea} onChange={setShowSafeArea} />
                    Показывать безопасную область
                </div>

                <div className={styles.sceneWrapper}>
                    <OverlayCanvas
                        mode="preview"
                        aspectRatio={layout.aspectRatio}
                        showSafeArea={showSafeArea}
                        minimapCover={activeSceneLayout.minimapCover}
                        referenceBackground={referenceBackgroundImage}
                    >
                        {({ sceneScale, sceneWidth, sceneHeight }) => (
                            <>
                                {activeSceneLayout.cameraZone.enabled && (
                                    <CameraZoneEditor
                                        zone={activeSceneLayout.cameraZone}
                                        sceneScale={sceneScale}
                                        sceneWidth={sceneWidth}
                                        sceneHeight={sceneHeight}
                                        onChange={updateCameraZone}
                                    />
                                )}
                                {VISIBLE_OVERLAY_WIDGET_IDS.map((id) => (
                                    <AnchoredWidget
                                        key={id}
                                        layout={activeSceneLayout.widgets[id]}
                                        sceneWidth={sceneWidth}
                                        sceneHeight={sceneHeight}
                                        interactive={{
                                            sceneScale,
                                            otherWidgetsBounds: otherBoundsFor(id),
                                            onCommitPosition: (xVw, yVh) =>
                                                updaters[id]({ xVw, yVh }),
                                            onSnapGuidesChange: setSnapGuides,
                                            onBoundsChange: (bounds) =>
                                                setWidgetBounds((current) => ({
                                                    ...current,
                                                    [id]: bounds ?? undefined,
                                                })),
                                        }}
                                    >
                                        {renderWidgetContent(id)}
                                    </AnchoredWidget>
                                ))}

                                {snapGuides.x && (
                                    <div
                                        className={styles.guideLineX}
                                        style={{ left: snapGuides.x.value }}
                                    />
                                )}
                                {snapGuides.y && (
                                    <div
                                        className={styles.guideLineY}
                                        style={{ top: snapGuides.y.value }}
                                    />
                                )}
                                {snapGuides.x?.kind === "widget-gap" && (
                                    <div
                                        className={styles.gapLabel}
                                        style={{
                                            left: snapGuides.x.value,
                                            top: sceneHeight / 2,
                                        }}
                                    >
                                        {snapGuides.x.gapLabel}
                                    </div>
                                )}
                                {snapGuides.y?.kind === "widget-gap" && (
                                    <div
                                        className={styles.gapLabel}
                                        style={{
                                            left: sceneWidth / 2,
                                            top: snapGuides.y.value,
                                        }}
                                    >
                                        {snapGuides.y.gapLabel}
                                    </div>
                                )}
                            </>
                        )}
                    </OverlayCanvas>
                </div>
                <div className={styles.sceneCaption}>
                    Безопасная область помогает не прижимать элементы к краям
                    трансляции - это лишь рекомендация, не жёсткое ограничение.
                </div>
                </div>
                </div>

                <div className={styles.actions}>
                    <Button onClick={handleReset}>Вернуть по умолчанию</Button>
                    {dirty && (
                        <span className={styles.dirtyHint}>Есть несохранённые изменения</span>
                    )}
                    <Button type="primary" loading={saving} onClick={handleSave}>
                        Сохранить
                    </Button>
                </div>
            </div>
        </div>
    );
};
