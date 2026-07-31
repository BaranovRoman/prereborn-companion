"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Button, Checkbox, Input, InputNumber, Modal, Select, Upload, message } from "antd";
import { DOTA_HEROES } from "@/entities/dota-hero/model/heroes";
import type { DotaHeroAttribute } from "@/entities/dota-hero/model/attributes";
import { useQueueSettings } from "@/entities/stream-queue-settings/lib/use-queue-settings";
import type {
    QueueChannelGoal,
    QueueSocialPlatform,
    QueueWidgetSettings,
} from "@/entities/stream-queue-settings/model/types";
import { queueWebcamImageApi } from "@/entities/stream-queue-settings/api/queue-webcam-image";
import styles from "./queue-widgets-panel.module.scss";

type ConfigurableWidgetId = keyof QueueWidgetSettings["titles"];

const WIDGETS: Array<{ id: ConfigurableWidgetId; label: string; description: string }> = [
    { id: "playerProfile", label: "Профиль и статистика", description: "Карточка профиля игрока." },
    { id: "streamProfile", label: "Канал и трансляция", description: "Цель трансляции." },
    { id: "featuredMatch", label: "Последний матч", description: "Карточка последнего матча." },
    { id: "webcam", label: "Область веб-камеры", description: "Резервное изображение для области камеры." },
    { id: "favoriteHeroes", label: "Любимые герои", description: "Выбор до трёх героев." },
    { id: "recentGames", label: "Последние игры", description: "Количество отображаемых матчей." },
    { id: "twitchChat", label: "Twitch-чат", description: "Количество сообщений." },
    { id: "friends", label: "Friends и соцсети", description: "Аудитория канала и ссылки на соцсети." },
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
    const [activeWidget, setActiveWidget] = useState<ConfigurableWidgetId | null>(null);
    const [widgetDraft, setWidgetDraft] = useState<QueueWidgetSettings | null>(null);
    const [savingWidget, setSavingWidget] = useState(false);

    const filteredHeroes = useMemo(() => {
        const query = heroQuery.trim().toLocaleLowerCase();
        return query
            ? DOTA_HEROES.filter((hero) =>
                  hero.localizedName.toLocaleLowerCase().includes(query)
              )
            : DOTA_HEROES;
    }, [heroQuery]);

    const openWidget = (id: ConfigurableWidgetId) => {
        setWidgetDraft(structuredClone(settings.widgets));
        setActiveWidget(id);
    };

    const saveWidget = async () => {
        if (!widgetDraft) return;
        setSavingWidget(true);
        try {
            await save({ ...settings, widgets: widgetDraft });
            setActiveWidget(null);
            messageApi.success("Настройки виджета сохранены");
        } catch {
            messageApi.error("Не удалось сохранить настройки виджета");
        } finally {
            setSavingWidget(false);
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
                {WIDGETS.map(({ id, label, description }) => (
                    <div key={id} className={styles.row}>
                        <span><strong>{label}</strong><small>{description}</small></span>
                        <Button disabled={loading} onClick={() => openWidget(id)}>
                            Настроить
                        </Button>
                    </div>
                ))}
            </div>
            <Modal
                title={WIDGETS.find((widget) => widget.id === activeWidget)?.label}
                open={Boolean(activeWidget && widgetDraft)}
                onCancel={() => setActiveWidget(null)}
                onOk={() => activeWidget === "webcam" ? setActiveWidget(null) : void saveWidget()}
                okText={activeWidget === "webcam" ? "Готово" : "Сохранить"}
                cancelText="Отмена"
                confirmLoading={savingWidget}
                destroyOnHidden
            >
                {activeWidget && widgetDraft && (
                    <div className={styles.widgetModal}>
                        {activeWidget === "recentGames" && (
                            <label>
                                <span>Количество матчей</span>
                                <InputNumber
                                    min={1}
                                    max={5}
                                    value={widgetDraft.recentGamesLimit}
                                    onChange={(value) => setWidgetDraft({
                                        ...widgetDraft,
                                        recentGamesLimit: Number(value ?? 5),
                                    })}
                                />
                            </label>
                        )}
                        {activeWidget === "twitchChat" && (
                            <label>
                                <span>Сообщений в чате</span>
                                <InputNumber
                                    min={3}
                                    max={30}
                                    value={widgetDraft.chatMessagesLimit}
                                    onChange={(value) => setWidgetDraft({
                                        ...widgetDraft,
                                        chatMessagesLimit: Number(value ?? 12),
                                    })}
                                />
                            </label>
                        )}
                        {activeWidget === "friends" && (
                            <div className={styles.friendsEditor}>
                                <strong>Разделы аудитории</strong>
                                {([
                                    ["showDonaters", "Топ донатеров"],
                                    ["showSubscribers", "Подписчики"],
                                    ["showFollowers", "Новые фолловеры"],
                                ] as const).map(([key, label]) => (
                                    <Checkbox
                                        key={key}
                                        checked={widgetDraft.friends[key]}
                                        onChange={(event) => setWidgetDraft({
                                            ...widgetDraft,
                                            friends: { ...widgetDraft.friends, [key]: event.target.checked },
                                        })}
                                    >
                                        {label}
                                    </Checkbox>
                                ))}
                                <strong>Социальные сети</strong>
                                {widgetDraft.friends.socialLinks.map((social, index) => (
                                    <div className={styles.socialRow} key={social.id}>
                                        <Select
                                            value={social.platform}
                                            options={["twitch", "youtube", "telegram", "discord", "vk", "x"].map((value) => ({ value, label: value.toUpperCase() }))}
                                            onChange={(platform: QueueSocialPlatform) => {
                                                const socialLinks = [...widgetDraft.friends.socialLinks];
                                                socialLinks[index] = { ...social, platform };
                                                setWidgetDraft({ ...widgetDraft, friends: { ...widgetDraft.friends, socialLinks } });
                                            }}
                                        />
                                        <Input
                                            value={social.label}
                                            placeholder="@username"
                                            onChange={(event) => {
                                                const socialLinks = [...widgetDraft.friends.socialLinks];
                                                socialLinks[index] = { ...social, label: event.target.value };
                                                setWidgetDraft({ ...widgetDraft, friends: { ...widgetDraft.friends, socialLinks } });
                                            }}
                                        />
                                        <Input
                                            value={social.url}
                                            placeholder="https://"
                                            onChange={(event) => {
                                                const socialLinks = [...widgetDraft.friends.socialLinks];
                                                socialLinks[index] = { ...social, url: event.target.value };
                                                setWidgetDraft({ ...widgetDraft, friends: { ...widgetDraft.friends, socialLinks } });
                                            }}
                                        />
                                        <Button
                                            danger
                                            onClick={() => setWidgetDraft({
                                                ...widgetDraft,
                                                friends: {
                                                    ...widgetDraft.friends,
                                                    socialLinks: widgetDraft.friends.socialLinks.filter((_, itemIndex) => itemIndex !== index),
                                                },
                                            })}
                                        >
                                            Удалить
                                        </Button>
                                    </div>
                                ))}
                                <Button
                                    disabled={widgetDraft.friends.socialLinks.length >= 8}
                                    onClick={() => setWidgetDraft({
                                        ...widgetDraft,
                                        friends: {
                                            ...widgetDraft.friends,
                                            socialLinks: [
                                                ...widgetDraft.friends.socialLinks,
                                                { id: crypto.randomUUID(), platform: "twitch", label: "", url: "" },
                                            ],
                                        },
                                    })}
                                >
                                    Добавить соцсеть
                                </Button>
                            </div>
                        )}
                        {activeWidget === "webcam" && (
                            <div className={styles.webcamEditor}>
                                <p>Фотография или заставка, если видеосигнал не используется.</p>
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
                            </div>
                        )}
                        {activeWidget === "favoriteHeroes" && <p>Состав героев настраивается ниже в каталоге героев.</p>}
                        {activeWidget === "streamProfile" && <p>Цель канала настраивается ниже в разделе трансляции.</p>}
                        {(activeWidget === "playerProfile" || activeWidget === "featuredMatch") && (
                            <p>У этого виджета нет дополнительных настроек.</p>
                        )}
                    </div>
                )}
            </Modal>
            <div className={styles.queueOptions}>
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
