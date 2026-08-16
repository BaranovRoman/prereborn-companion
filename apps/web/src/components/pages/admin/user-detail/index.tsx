"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
    Alert,
    Button,
    Card,
    ConfigProvider,
    Descriptions,
    Popconfirm,
    Spin,
    Tag,
    Typography,
    message,
    theme,
} from "antd";
import { useStreamSession } from "@/entities/stream-user/lib/use-stream-session";
import { useAdminUserDetail } from "@/entities/admin/lib/use-admin-user-detail";
import { adminUsersApi } from "@/entities/admin/api/admin-users-api";
import { usePageReady } from "@/shared/ui/route-transition/usePageReady";
import styles from "./index.module.scss";

const formatDate = (value: string | null): string =>
    value ? new Date(value).toLocaleString("ru-RU") : "—";

export const AdminUserDetailPage = ({ id }: { id: string }) => {
    const router = useRouter();
    const { user: sessionUser, loading: sessionLoading } = useStreamSession();
    const { detail, loading, errorStatus, refresh } = useAdminUserDetail(id);
    const [messageApi, contextHolder] = message.useMessage();
    const [isEndingSession, setIsEndingSession] = useState(false);
    const [isResettingOnboarding, setIsResettingOnboarding] = useState(false);

    const { ready } = usePageReady(600);
    useEffect(() => {
        ready();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (!sessionLoading && !sessionUser) {
            router.replace(`/stream/login?next=/admin/${id}`);
        }
    }, [sessionLoading, sessionUser, router, id]);

    const handleEndSession = async () => {
        setIsEndingSession(true);
        try {
            await adminUsersApi.endActiveSession(id);
            messageApi.success("Сессия завершена");
            refresh();
        } catch {
            messageApi.error("Не удалось завершить сессию");
        } finally {
            setIsEndingSession(false);
        }
    };

    const handleResetOnboarding = async () => {
        setIsResettingOnboarding(true);
        try {
            await adminUsersApi.resetOnboarding(id);
            messageApi.success("Онбординг сброшен");
            refresh();
        } catch {
            messageApi.error("Не удалось сбросить онбординг");
        } finally {
            setIsResettingOnboarding(false);
        }
    };

    let body: React.ReactNode;

    if (loading) {
        body = <Spin className={styles.spinner} />;
    } else if (errorStatus === 403) {
        body = <Alert type="error" showIcon message="Доступ запрещён" />;
    } else if (errorStatus === 404) {
        body = <Alert type="warning" showIcon message="Пользователь не найден" />;
    } else if (!detail) {
        body = (
            <Alert type="error" showIcon message="Не удалось загрузить пользователя" />
        );
    } else {
        const activeSession =
            detail.latestSession && !detail.latestSession.endedAt
                ? detail.latestSession
                : null;

        body = (
            <>
                <Card title="Аккаунт" className={styles.card}>
                    <Descriptions column={1} size="small">
                        <Descriptions.Item label="Email">{detail.email}</Descriptions.Item>
                        <Descriptions.Item label="ID">{detail.id}</Descriptions.Item>
                        <Descriptions.Item label="Регистрация">
                            {formatDate(detail.createdAt)}
                        </Descriptions.Item>
                        <Descriptions.Item label="Режим матчей">
                            {detail.gameMode}
                        </Descriptions.Item>
                        <Descriptions.Item label="Онбординг">
                            {detail.onboardingCompletedAt ? (
                                <Tag color="green">
                                    завершён {formatDate(detail.onboardingCompletedAt)}
                                </Tag>
                            ) : (
                                <Tag>не завершён</Tag>
                            )}
                        </Descriptions.Item>
                        <Descriptions.Item label="Companion-токен">
                            {detail.companionTokenConfigured ? (
                                <Tag color="blue">
                                    настроен {formatDate(detail.companionTokenCreatedAt)}
                                </Tag>
                            ) : (
                                <Tag>не настроен</Tag>
                            )}
                        </Descriptions.Item>
                    </Descriptions>
                </Card>

                <Card title="Привязки" className={styles.card}>
                    <Descriptions column={1} size="small">
                        <Descriptions.Item label="Steam">
                            {detail.steam ? (
                                <>
                                    {detail.steam.steamId64} (dota #{detail.steam.dotaAccountId}
                                    ), с {formatDate(detail.steam.connectedAt)}
                                </>
                            ) : (
                                "не привязан"
                            )}
                        </Descriptions.Item>
                        <Descriptions.Item label="Twitch">
                            {detail.twitch ? (
                                <>
                                    {detail.twitch.displayName} (@{detail.twitch.login}), с{" "}
                                    {formatDate(detail.twitch.connectedAt)}
                                </>
                            ) : (
                                "не привязан"
                            )}
                        </Descriptions.Item>
                    </Descriptions>
                </Card>

                <Card title="Companion / GSI" className={styles.card}>
                    <Descriptions column={1} size="small">
                        <Descriptions.Item label="Статус">
                            {detail.companion.online ? (
                                <Tag color="green">online</Tag>
                            ) : (
                                <Tag>offline</Tag>
                            )}
                        </Descriptions.Item>
                        <Descriptions.Item label="Последняя активность">
                            {formatDate(detail.companion.lastSeenAt)}
                        </Descriptions.Item>
                        <Descriptions.Item label="Последний GSI-пакет">
                            {formatDate(detail.companion.lastGsiReceivedAt)}
                        </Descriptions.Item>
                        <Descriptions.Item label="Версия Companion">
                            {detail.companion.companionVersion ?? "—"}
                        </Descriptions.Item>
                    </Descriptions>
                </Card>

                <Card
                    title="Текущий / последний стрим"
                    className={styles.card}
                    extra={
                        activeSession && (
                            <Popconfirm
                                title="Завершить активную сессию?"
                                description="Действие необратимо. Новая сессия начнётся при следующем матче."
                                okText="Завершить"
                                cancelText="Отмена"
                                onConfirm={handleEndSession}
                            >
                                <Button danger loading={isEndingSession} size="small">
                                    Завершить сессию
                                </Button>
                            </Popconfirm>
                        )
                    }
                >
                    {detail.latestSession ? (
                        <Descriptions column={1} size="small">
                            <Descriptions.Item label="Статус">
                                {activeSession ? (
                                    <Tag color="gold">активна</Tag>
                                ) : (
                                    <Tag>завершена</Tag>
                                )}
                            </Descriptions.Item>
                            <Descriptions.Item label="Начало">
                                {formatDate(detail.latestSession.startedAt)}
                            </Descriptions.Item>
                            <Descriptions.Item label="Конец">
                                {formatDate(detail.latestSession.endedAt)}
                            </Descriptions.Item>
                            <Descriptions.Item label="Счёт">
                                {detail.latestSession.wins}W / {detail.latestSession.losses}L
                            </Descriptions.Item>
                            <Descriptions.Item label="Рейтинг">
                                {detail.latestSession.rating ?? "—"}
                            </Descriptions.Item>
                        </Descriptions>
                    ) : (
                        "стримов ещё не было"
                    )}
                </Card>

                <Card title="Support actions" className={styles.card}>
                    <Popconfirm
                        title="Сбросить онбординг?"
                        description="Пользователь снова увидит шаги настройки Companion/OBS."
                        okText="Сбросить"
                        cancelText="Отмена"
                        onConfirm={handleResetOnboarding}
                        disabled={!detail.onboardingCompletedAt}
                    >
                        <Button
                            loading={isResettingOnboarding}
                            disabled={!detail.onboardingCompletedAt}
                        >
                            Сбросить онбординг
                        </Button>
                    </Popconfirm>
                </Card>
            </>
        );
    }

    return (
        <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
            <div className={styles.page}>
                {contextHolder}
                <Link href="/admin" className={styles.back}>
                    ← Все пользователи
                </Link>
                <Typography.Title level={3} className={styles.title}>
                    Пользователь
                </Typography.Title>
                {body}
            </div>
        </ConfigProvider>
    );
};
