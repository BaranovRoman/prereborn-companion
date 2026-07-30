"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { Button, Collapse, ConfigProvider, Dropdown, Popconfirm, message, theme } from "antd";
import type { CollapseProps, MenuProps } from "antd";
import { DownOutlined, UserOutlined } from "@ant-design/icons";
import { useStreamSession } from "@/entities/stream-user/lib/use-stream-session";
import { streamAuthApi } from "@/entities/stream-user/api/stream-auth";
import { clearStreamTokens } from "@/entities/stream-user/lib/tokens";
import { useSteamIntegration } from "@/entities/steam-integration/lib/use-steam-integration";
import { useOverlayPolling } from "@/entities/stream-session/lib/use-overlay-polling";
import { useAccountMatches } from "@/entities/stream-session/lib/use-account-matches";
import { usePageReady } from "@/shared/ui/route-transition/usePageReady";
import { siteUrl } from "@/shared/config/site";
import type { StreamUser } from "@/entities/stream-user/model/types";
import { StreamSessionPanel } from "./stream-session-panel";
import { QuickMatchPanel } from "./quick-match-panel";
import { RecentMatchesPanel } from "./recent-matches-panel";
import { IntegrationsCard } from "./integrations-card";
import { QueueWidgetsPanel } from "./queue-widgets-panel";
import { useTwitchIntegration } from "@/entities/twitch-integration/lib/use-twitch-integration";
import { useDonationAlertsIntegration } from "@/entities/donation-alerts-integration/lib/use-donation-alerts-integration";
import styles from "./index.module.scss";

// Человеко-понятные причины ошибки привязки Steam - reason приходит от
// backend-редиректа (controllers/stream/steam.ts) как безопасный код, не
// сырое сообщение/stack trace.
const STEAM_ERROR_MESSAGES: Record<string, string> = {
    missing_state: "Истекло время привязки Steam, попробуйте ещё раз.",
    invalid_state: "Истекло время привязки Steam, попробуйте ещё раз.",
    verification_failed: "Не удалось подтвердить вход через Steam.",
    already_linked: "Этот Steam-аккаунт уже привязан к другому профилю.",
    internal: "Не удалось привязать Steam. Попробуйте ещё раз.",
};

export const StreamSettingsPage = () => {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { user: sessionUser, loading } = useStreamSession();
    const [user, setUser] = useState<StreamUser | null>(null);
    const [isRegenerating, setIsRegenerating] = useState(false);
    const [matchesRefreshToken, setMatchesRefreshToken] = useState(0);
    const [messageApi, contextHolder] = message.useMessage();
    const steamIntegration = useSteamIntegration();
    const twitchIntegration = useTwitchIntegration();
    const donationAlertsIntegration = useDonationAlertsIntegration();
    const { matches, handleUpdated: handleMatchUpdated } = useAccountMatches();
    // Тот же публичный /overlay/:publicToken, что читает OBS - переиспользуем
    // его и здесь, чтобы получить sessionRatingDelta и статус Companion, не
    // заводя новый authenticated-эндпоинт (см. use-overlay-polling.ts).
    const overlayData = useOverlayPolling(
        user?.publicToken ?? "",
        null,
        matchesRefreshToken
    );

    // См. комментарий в components/pages/stream/login/index.tsx. Не ждём
    // завершения проверки сессии - "Загрузка…" уже валидный первый кадр
    // страницы, шторка не должна висеть до реального разрешения auth-стейта.
    const { ready } = usePageReady(600);
    useEffect(() => {
        ready();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (sessionUser) setUser(sessionUser);
    }, [sessionUser]);

    useEffect(() => {
        if (!loading && !sessionUser) {
            router.replace("/stream/login");
        }
    }, [loading, sessionUser, router]);

    // Возврат из Steam OpenID callback (controllers/stream/steam.ts) -
    // одноразовое сообщение по query-параметру, дальше сразу чистим URL,
    // чтобы обновление страницы не показывало тост повторно.
    useEffect(() => {
        const steamStatus = searchParams.get("steam");
        if (!steamStatus) return;

        if (steamStatus === "connected") {
            messageApi.success("Steam подключён");
            steamIntegration.refresh();
        } else if (steamStatus === "error") {
            const reason = searchParams.get("reason") ?? "";
            messageApi.error(
                STEAM_ERROR_MESSAGES[reason] ?? "Не удалось привязать Steam"
            );
        }

        router.replace("/stream");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchParams]);

    useEffect(() => {
        const status = searchParams.get("donationAlerts");
        if (!status) return;
        if (status === "connected") {
            messageApi.success("DonationAlerts подключён");
            void donationAlertsIntegration.refresh();
        } else messageApi.error("Не удалось подключить DonationAlerts");
        router.replace("/stream");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchParams]);

    useEffect(() => {
        const twitchStatus = searchParams.get("twitch");
        if (!twitchStatus) return;
        if (twitchStatus === "connected") {
            messageApi.success("Twitch подключён");
            void twitchIntegration.refresh();
        } else {
            messageApi.error("Не удалось подключить Twitch");
        }
        router.replace("/stream");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchParams]);

    if (loading || !user) {
        return <div className={styles.loading}>Загрузка…</div>;
    }

    const obsUrl = siteUrl(`/overlay/${user.publicToken}`);

    const handleCopy = async () => {
        await navigator.clipboard.writeText(obsUrl);
        messageApi.success("Ссылка скопирована");
    };

    const handleRegenerate = async () => {
        setIsRegenerating(true);
        try {
            const updated = await streamAuthApi.regenerateToken();
            setUser(updated);
            messageApi.success("Новая ссылка сгенерирована");
        } catch {
            messageApi.error("Не удалось обновить ссылку");
        } finally {
            setIsRegenerating(false);
        }
    };

    const handleLogout = async () => {
        await streamAuthApi.logout();
        clearStreamTokens();
        router.push("/stream/login");
    };

    const accountMenuItems: MenuProps["items"] = [
        { key: "email", label: user.email, disabled: true },
        { type: "divider" },
        { key: "logout", label: "Выйти", danger: true, onClick: handleLogout },
    ];

    const overlaySettingsItems: CollapseProps["items"] = [
        {
            key: "overlay-advanced",
            label: "Дополнительные настройки",
            children: (
                <Popconfirm
                    title="Создать новую OBS-ссылку?"
                    description="Старая ссылка перестанет работать в OBS."
                    okText="Создать"
                    cancelText="Отмена"
                    onConfirm={handleRegenerate}
                >
                    <Button loading={isRegenerating} danger type="text">
                        Создать новую OBS-ссылку
                    </Button>
                </Popconfirm>
            ),
        },
    ];

    const recentMatches = overlayData?.matches ?? [];
    const lastMatch = matches?.[0] ?? null;
    const handleMatchCorrection = (updated: Parameters<typeof handleMatchUpdated>[0]) => {
        void handleMatchUpdated(updated);
        setMatchesRefreshToken((value) => value + 1);
    };

    return (
        <ConfigProvider
            theme={{
                algorithm: theme.darkAlgorithm,
                token: {
                    fontFamily:
                        '"Radiance", "PT Sans Narrow", "Arial Narrow", Arial, sans-serif',
                    fontSize: 14,
                    borderRadius: 2,
                    borderRadiusLG: 2,
                    controlHeight: 36,
                    colorPrimary: "#7b3532",
                    colorPrimaryHover: "#98504a",
                    colorPrimaryActive: "#632b29",
                    colorBgContainer: "#15191a",
                    colorBgElevated: "#202526",
                    colorBorder: "#3a3f40",
                    colorText: "#c8c4bd",
                    colorTextSecondary: "#8b8e89",
                },
            }}
        >
        <div className={styles.page}>
            {contextHolder}

            <header className={styles.header}>
                <div className={styles.brand}>
                    <Image
                        className={styles.brandLogo}
                        src="/logo.png"
                        width={52}
                        height={52}
                        alt="PreReborn Companion"
                        priority
                    />
                    <div>
                        <div className={styles.brandName}>PreReborn Companion</div>
                        <h1 className={styles.title}>Стрим-дашборд</h1>
                    </div>
                </div>
                <div className={styles.headerRight}>
                    <span className={styles.statusChip}>
                        <span
                            className={`${styles.statusDot} ${
                                overlayData?.companion.isOnline
                                    ? styles.statusDotOn
                                    : styles.statusDotOff
                            }`}
                        />
                        Companion {overlayData?.companion.isOnline ? "online" : "offline"}
                    </span>
                    <span className={styles.statusChip}>
                        <span
                            className={`${styles.statusDot} ${
                                steamIntegration.status?.connected
                                    ? styles.statusDotOn
                                    : styles.statusDotOff
                            }`}
                        />
                        Steam {steamIntegration.status?.connected ? "подключён" : "не подключён"}
                    </span>
                    <Dropdown menu={{ items: accountMenuItems }} trigger={["click"]}>
                        <button className={styles.accountButton}>
                            <UserOutlined />
                            <span className={styles.accountEmail}>{user.email}</span>
                            <DownOutlined className={styles.accountCaret} />
                        </button>
                    </Dropdown>
                </div>
            </header>

            <div className={styles.grid}>
                <div className={styles.dashboardColumn}>
                    <StreamSessionPanel
                        steamConnected={steamIntegration.status?.connected ?? false}
                        sessionRatingDelta={overlayData?.sessionRatingDelta ?? null}
                        gameMode={user.gameMode}
                        onGameModeChanged={(gameMode) => setUser({ ...user, gameMode })}
                    />
                    <RecentMatchesPanel
                        recentMatches={recentMatches}
                        matches={matches}
                        onUpdated={handleMatchCorrection}
                    />
                </div>

                <div className={styles.dashboardColumn}>
                    {matches === null ? (
                        <div className={styles.section}>
                            <h2 className={styles.sectionTitle}>Последний матч</h2>
                            <div className={styles.loadingHint}>Загрузка…</div>
                        </div>
                    ) : lastMatch ? (
                        <QuickMatchPanel match={lastMatch} onUpdated={handleMatchCorrection} />
                    ) : (
                        <div className={styles.section}>
                            <h2 className={styles.sectionTitle}>Последний матч</h2>
                            <div className={styles.loadingHint}>Матчей пока нет</div>
                        </div>
                    )}

                    <div className={styles.section}>
                        <h2 className={styles.sectionTitle}>Оверлей</h2>
                        <div className={styles.overlayState}>
                            {overlayData
                                ? `Данные обновлены ${new Date(overlayData.updatedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`
                                : "Загрузка состояния…"}
                        </div>

                        <div className={styles.urlRow}>
                            <input
                                readOnly
                                value={obsUrl}
                                className={styles.urlInput}
                                onFocus={(e) => e.currentTarget.select()}
                            />
                        </div>

                        <div className={styles.overlayActions}>
                            <Button onClick={handleCopy}>Скопировать OBS URL</Button>
                            <Link href="/stream/overlay-editor">
                                <Button type="default">Настроить расположение виджетов</Button>
                            </Link>
                        </div>

                        <Collapse
                            className={styles.overlayCollapse}
                            items={overlaySettingsItems}
                            defaultActiveKey={[]}
                            ghost
                        />
                    </div>
                </div>

                <div className={styles.fullSpan}>
                    <QueueWidgetsPanel currentRating={overlayData?.rating ?? null} />
                </div>

                <div className={styles.fullSpan}>
                    <IntegrationsCard
                        steamStatus={steamIntegration.status}
                        steamLoading={steamIntegration.loading}
                        steamIsSyncing={steamIntegration.isSyncing}
                        onSteamSync={steamIntegration.sync}
                        onSteamDisconnected={steamIntegration.refresh}
                        companion={overlayData?.companion ?? null}
                        companionTokenConfigured={user.companionTokenConfigured}
                        companionTokenCreatedAt={user.companionTokenCreatedAt}
                        onCompanionRegenerated={(createdAt) =>
                            setUser({
                                ...user,
                                companionTokenConfigured: true,
                                companionTokenCreatedAt: createdAt,
                            })
                        }
                        twitchStatus={twitchIntegration.status}
                        twitchLoading={twitchIntegration.loading}
                        onTwitchChanged={twitchIntegration.refresh}
                        donationAlertsStatus={donationAlertsIntegration.status}
                        donationAlertsLoading={donationAlertsIntegration.loading}
                        onDonationAlertsChanged={donationAlertsIntegration.refresh}
                    />
                </div>
            </div>
        </div>
        </ConfigProvider>
    );
};
