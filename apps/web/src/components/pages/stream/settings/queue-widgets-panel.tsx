"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Button, Input, InputNumber, Select, Switch, Upload, message } from "antd";
import { DOTA_HEROES } from "@/entities/dota-hero/model/heroes";
import type { DotaHeroAttribute } from "@/entities/dota-hero/model/attributes";
import { useQueueSettings } from "@/entities/stream-queue-settings/lib/use-queue-settings";
import type {
    QueueChannelGoal,
    QueueWidgetId,
} from "@/entities/stream-queue-settings/model/types";
import { queueWebcamImageApi } from "@/entities/stream-queue-settings/api/queue-webcam-image";
import styles from "./queue-widgets-panel.module.scss";

const WIDGETS: Array<{ id: QueueWidgetId; label: string }> = [
    { id: "playerProfile", label: "Профиль и статистика" },
    { id: "streamProfile", label: "Канал и трансляция" },
    { id: "featuredMatch", label: "Последний матч" },
    { id: "webcam", label: "Область веб-камеры" },
    { id: "favoriteHeroes", label: "Любимые герои" },
    { id: "recentGames", label: "Последние игры" },
    { id: "twitchChat", label: "Twitch-чат" },
];

const ATTRIBUTES: Array<{
    id: DotaHeroAttribute;
    label: string;
    iconUrl: string;
}> = [
    {
        id: "strength",
        label: "Сила",
        iconUrl: "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/icons/hero_strength.png",
    },
    {
        id: "agility",
        label: "Ловкость",
        iconUrl: "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/icons/hero_agility.png",
    },
    {
        id: "intelligence",
        label: "Интеллект",
        iconUrl: "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/icons/hero_intelligence.png",
    },
    {
        id: "universal",
        label: "Универсальные",
        iconUrl: "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/icons/hero_universal.png",
    },
];

export const QueueWidgetsPanel = ({
    currentRating,
}: {
    currentRating: number | null;
}) => {
    const { settings, loading, save } = useQueueSettings();
    const [messageApi, contextHolder] = message.useMessage();
    const [heroQuery, setHeroQuery] = useState("");
    const [goalDraftOverride, setGoalDraft] =
        useState<QueueChannelGoal | null>(null);
    const goalDraft = goalDraftOverride ?? settings.channelGoal;
    const [savingGoal, setSavingGoal] = useState(false);
    const [uploadingImage, setUploadingImage] = useState(false);

    const filteredHeroes = useMemo(() => {
        const query = heroQuery.trim().toLocaleLowerCase();
        return query
            ? DOTA_HEROES.filter((hero) =>
                  hero.localizedName.toLocaleLowerCase().includes(query)
              )
            : DOTA_HEROES;
    }, [heroQuery]);

    const toggle = async (id: QueueWidgetId, visible: boolean) => {
        try {
            await save({
                ...settings,
                visibility: { ...settings.visibility, [id]: visible },
            });
        } catch {
            messageApi.error("Не удалось сохранить настройки queue");
        }
    };

    const toggleFavoriteHero = async (heroId: number) => {
        const selected = settings.favoriteHeroIds.includes(heroId);
        const heroIds = selected
            ? settings.favoriteHeroIds.filter((id) => id !== heroId)
            : [...settings.favoriteHeroIds, heroId];
        if (heroIds.length > 3) {
            messageApi.warning("Можно выбрать не больше трёх героев");
            return;
        }
        try {
            await save({ ...settings, favoriteHeroIds: heroIds });
        } catch {
            messageApi.error("Не удалось сохранить любимых героев");
        }
    };

    const saveGoal = async () => {
        setSavingGoal(true);
        try {
            await save({ ...settings, channelGoal: goalDraft });
            messageApi.success("Цель трансляции сохранена");
        } catch {
            messageApi.error("Не удалось сохранить цель трансляции");
        } finally {
            setSavingGoal(false);
        }
    };

    const uploadWebcamImage = async (file: File) => {
        setUploadingImage(true);
        try {
            const uploaded = await queueWebcamImageApi.upload(file);
            await save(uploaded);
            messageApi.success("Изображение для области веб-камеры сохранено");
        } catch {
            messageApi.error("Не удалось загрузить изображение");
        } finally {
            setUploadingImage(false);
        }
        return false;
    };

    const removeWebcamImage = async () => {
        setUploadingImage(true);
        try {
            await queueWebcamImageApi.remove();
            await save({ ...settings, webcamImageUrl: null });
            messageApi.success("Изображение удалено");
        } catch {
            messageApi.error("Не удалось удалить изображение");
        } finally {
            setUploadingImage(false);
        }
    };

    return (
        <section className={styles.section}>
            {contextHolder}
            <div className={styles.header}>
                <div>
                    <h2>Виджеты Queue</h2>
                    <p>Управляйте блоками экрана поиска матча. Настройки сохраняются в аккаунте.</p>
                </div>
                <Link href="/stream/queue"><Button>Открыть Queue</Button></Link>
            </div>
            <div className={styles.grid} aria-busy={loading}>
                {WIDGETS.map(({ id, label }) => (
                    <label key={id} className={styles.row}>
                        <span>{label}</span>
                        <Switch
                            checked={settings.visibility[id]}
                            disabled={loading}
                            onChange={(checked) => void toggle(id, checked)}
                        />
                    </label>
                ))}
            </div>
            <div className={styles.queueOptions}>
                <section className={styles.optionCard}>
                    <div>
                        <strong>Изображение области веб-камеры</strong>
                        <span>Фотография или заставка, если видеосигнал не используется.</span>
                    </div>
                    {settings.webcamImageUrl && (
                        <img
                            className={styles.webcamPreview}
                            src={settings.webcamImageUrl}
                            alt="Предпросмотр области веб-камеры"
                        />
                    )}
                    <div className={styles.optionActions}>
                        <Upload
                            accept="image/jpeg,image/png,image/webp"
                            showUploadList={false}
                            beforeUpload={(file) => {
                                void uploadWebcamImage(file);
                                return false;
                            }}
                        >
                            <Button loading={uploadingImage}>Выбрать изображение</Button>
                        </Upload>
                        {settings.webcamImageUrl && (
                            <Button
                                danger
                                type="text"
                                loading={uploadingImage}
                                onClick={() => void removeWebcamImage()}
                            >
                                Удалить
                            </Button>
                        )}
                    </div>
                </section>
                <section className={styles.optionCard}>
                    <div>
                        <strong>Цель канала и трансляции</strong>
                        <span>Twitch заполняет данные канала. Цель можно связать с рейтингом или указать вручную.</span>
                    </div>
                    <div className={styles.goalEditor}>
                        <Select
                            value={goalDraft.type}
                            options={[
                                { value: "none", label: "Без цели" },
                                { value: "rating", label: "Цель по рейтингу" },
                                { value: "custom", label: "Своя цель" },
                            ]}
                            onChange={(type: QueueChannelGoal["type"]) => {
                                const startValue =
                                    type === "rating"
                                        ? currentRating ?? 0
                                        : goalDraft.startValue;
                                setGoalDraft({
                                    ...goalDraft,
                                    type,
                                    startValue,
                                    targetValue:
                                        type === "rating"
                                            ? startValue + 300
                                            : goalDraft.targetValue,
                                    label:
                                        type === "rating"
                                            ? "RATING GOAL"
                                            : goalDraft.label,
                                });
                            }}
                        />
                        {goalDraft.type !== "none" && (
                            <>
                                <Input
                                    value={goalDraft.label}
                                    maxLength={48}
                                    placeholder="Название цели"
                                    onChange={(event) =>
                                        setGoalDraft({
                                            ...goalDraft,
                                            label: event.target.value,
                                        })
                                    }
                                />
                                <InputNumber
                                    value={goalDraft.startValue}
                                    placeholder="Старт"
                                    onChange={(value) =>
                                        setGoalDraft({
                                            ...goalDraft,
                                            startValue: Number(value ?? 0),
                                        })
                                    }
                                />
                                <InputNumber
                                    value={goalDraft.targetValue}
                                    placeholder="Цель"
                                    onChange={(value) =>
                                        setGoalDraft({
                                            ...goalDraft,
                                            targetValue: Number(value ?? 0),
                                        })
                                    }
                                />
                            </>
                        )}
                        <Button
                            type="primary"
                            loading={savingGoal}
                            onClick={() => void saveGoal()}
                        >
                            Сохранить цель
                        </Button>
                    </div>
                </section>
            </div>
            <div className={styles.heroPicker}>
                <div className={styles.heroPickerHeader}>
                    <div>
                    <strong>Герои в Favorite Heroes</strong>
                    <span>Выберите до трёх. Пустой список — автоматически по истории матчей.</span>
                    </div>
                    <div className={styles.heroPickerTools}>
                        <span className={styles.selectionCount}>
                            {settings.favoriteHeroIds.length} / 3
                        </span>
                        <Input
                            allowClear
                            value={heroQuery}
                            placeholder="Поиск героя"
                            onChange={(event) => setHeroQuery(event.target.value)}
                        />
                    </div>
                </div>
                <div className={styles.attributeGrid}>
                    {ATTRIBUTES.map((attribute) => {
                        const heroes = filteredHeroes
                            .filter((hero) => hero.attribute === attribute.id)
                            .sort((a, b) => a.localizedName.localeCompare(b.localizedName));
                        return (
                            <section
                                key={attribute.id}
                                className={styles.attributeColumn}
                                data-attribute={attribute.id}
                            >
                                <h3>
                                    <img src={attribute.iconUrl} alt="" aria-hidden="true" />
                                    {attribute.label}
                                </h3>
                                <div className={styles.heroGrid}>
                                    {heroes.map((hero) => {
                                        const selected = settings.favoriteHeroIds.includes(hero.id);
                                        const disabled =
                                            loading ||
                                            (!selected && settings.favoriteHeroIds.length >= 3);
                                        return (
                                            <button
                                                key={hero.id}
                                                type="button"
                                                className={styles.heroTile}
                                                data-selected={selected}
                                                disabled={disabled}
                                                title={hero.localizedName}
                                                onClick={() => void toggleFavoriteHero(hero.id)}
                                            >
                                                <img src={hero.imageUrl} alt="" />
                                                <span>{hero.localizedName}</span>
                                                <b aria-hidden="true">✓</b>
                                            </button>
                                        );
                                    })}
                                </div>
                            </section>
                        );
                    })}
                </div>
            </div>
        </section>
    );
};
