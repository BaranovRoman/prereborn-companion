"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
    Alert,
    ConfigProvider,
    Input,
    Table,
    Tag,
    Typography,
    theme,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useStreamSession } from "@/entities/stream-user/lib/use-stream-session";
import { useAdminUsers } from "@/entities/admin/lib/use-admin-users";
import { usePageReady } from "@/shared/ui/route-transition/usePageReady";
import type { AdminUserSummary } from "@/entities/admin/model/types";
import styles from "./index.module.scss";

const formatDate = (value: string | null): string =>
    value ? new Date(value).toLocaleString("ru-RU") : "—";

const columns: ColumnsType<AdminUserSummary> = [
    {
        title: "Email",
        dataIndex: "email",
        key: "email",
        render: (email: string, row) => (
            <Link href={`/admin/${row.id}`}>{email}</Link>
        ),
    },
    {
        title: "Регистрация",
        dataIndex: "createdAt",
        key: "createdAt",
        render: formatDate,
    },
    {
        title: "Онбординг",
        dataIndex: "onboardingCompletedAt",
        key: "onboarding",
        render: (value: string | null) =>
            value ? (
                <Tag color="green">завершён</Tag>
            ) : (
                <Tag color="default">не завершён</Tag>
            ),
    },
    {
        title: "Steam",
        dataIndex: "steamConnected",
        key: "steam",
        render: (connected: boolean) =>
            connected ? <Tag color="blue">привязан</Tag> : <Tag>—</Tag>,
    },
    {
        title: "Twitch",
        dataIndex: "twitchConnected",
        key: "twitch",
        render: (connected: boolean, row) =>
            connected ? (
                <Tag color="purple">{row.twitchDisplayName ?? "привязан"}</Tag>
            ) : (
                <Tag>—</Tag>
            ),
    },
    {
        title: "Companion",
        dataIndex: "companionOnline",
        key: "companion",
        render: (online: boolean, row) =>
            online ? (
                <Tag color="green">online</Tag>
            ) : (
                <Tag color="default">
                    {row.companionLastSeenAt
                        ? `был(а) ${formatDate(row.companionLastSeenAt)}`
                        : "нет данных"}
                </Tag>
            ),
    },
    {
        title: "Активный стрим",
        dataIndex: "activeSessionStartedAt",
        key: "activeSession",
        render: (value: string | null) =>
            value ? <Tag color="gold">с {formatDate(value)}</Tag> : "—",
    },
];

export const AdminUsersListPage = () => {
    const router = useRouter();
    const { user: sessionUser, loading: sessionLoading } = useStreamSession();
    const {
        users,
        total,
        loading,
        error,
        query,
        setQuery,
        page,
        pageSize,
        setPage,
    } = useAdminUsers();

    const { ready } = usePageReady(600);
    useEffect(() => {
        ready();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (!sessionLoading && !sessionUser) {
            router.replace("/stream/login?next=/admin");
        }
    }, [sessionLoading, sessionUser, router]);

    return (
        <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
            <div className={styles.page}>
                <Typography.Title level={3} className={styles.title}>
                    Администрирование пользователей
                </Typography.Title>

                {error && (
                    <Alert
                        type="error"
                        message={error}
                        showIcon
                        className={styles.alert}
                    />
                )}

                <Input.Search
                    placeholder="Поиск по email"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    allowClear
                    className={styles.search}
                />

                <Table<AdminUserSummary>
                    className={styles.table}
                    rowKey="id"
                    columns={columns}
                    dataSource={users}
                    loading={loading}
                    pagination={{
                        current: page,
                        pageSize,
                        total,
                        onChange: setPage,
                        showSizeChanger: false,
                    }}
                />
            </div>
        </ConfigProvider>
    );
};
