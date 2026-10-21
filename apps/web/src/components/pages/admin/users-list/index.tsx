"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ConfigProvider, Input, Table, Tag, theme } from "antd";
import type { ColumnsType, SorterResult } from "antd/es/table/interface";
import { useStreamSession } from "@/entities/stream-user/lib/use-stream-session";
import { useAdminUsers } from "@/entities/admin/lib/use-admin-users";
import { adminUsersApi } from "@/entities/admin/api/admin-users-api";
import type { AdminUsageStats, AdminUserSort, AdminUserSummary } from "@/entities/admin/model/types";
import styles from "./index.module.scss";

const formatDateTime = (value: string | null): string =>
    value ? new Date(value).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" }) : "—";

const formatDay = (value: string) =>
    new Date(`${value}T00:00:00Z`).toLocaleDateString("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" });

// Table column key → server sort key (the API only accepts whitelisted keys).
const SORTS: Record<string, { ascend?: AdminUserSort; descend?: AdminUserSort }> = {
    createdAt: { ascend: "created_asc", descend: "created_desc" },
    lastCompanionActivityAt: { descend: "activity_desc" },
    email: { ascend: "email_asc" },
};

const sortOrderFor = (sort: AdminUserSort, key: string) => {
    const entry = SORTS[key];
    if (entry?.ascend === sort) return "ascend" as const;
    if (entry?.descend === sort) return "descend" as const;
    return null;
};

const buildColumns = (sort: AdminUserSort): ColumnsType<AdminUserSummary> => [
    { title: "ID", dataIndex: "id", key: "id", width: 72 },
    {
        title: "Email",
        dataIndex: "email",
        key: "email",
        sorter: true,
        sortDirections: ["ascend"],
        sortOrder: sortOrderFor(sort, "email"),
        render: (email: string, row) => (
            <span className={styles.email}>
                <Link href={`/admin/${row.id}`}>{email}</Link>
                {row.isAdmin && <Tag color="geekblue">админ</Tag>}
            </span>
        ),
    },
    {
        title: "Регистрация",
        dataIndex: "createdAt",
        key: "createdAt",
        sorter: true,
        sortDirections: ["descend", "ascend"],
        sortOrder: sortOrderFor(sort, "createdAt"),
        render: formatDateTime,
    },
    {
        title: "Последняя активность Companion",
        dataIndex: "lastCompanionActivityAt",
        key: "lastCompanionActivityAt",
        sorter: true,
        sortDirections: ["descend"],
        sortOrder: sortOrderFor(sort, "lastCompanionActivityAt"),
        render: (value: string | null) =>
            value ? formatDateTime(value) : <span className={styles.muted}>не запускал</span>,
    },
    {
        title: "Дней за 30",
        dataIndex: "activeDays30d",
        key: "activeDays30d",
        align: "right",
        width: 120,
    },
    {
        title: "Привязки",
        key: "links",
        render: (_, row) => {
            const tags = [
                row.steamConnected && <Tag key="steam" color="blue">Steam</Tag>,
                row.twitchConnected && <Tag key="twitch" color="purple">Twitch</Tag>,
                row.legacyTokenConfigured && <Tag key="legacy">старый токен</Tag>,
            ].filter(Boolean);
            return tags.length ? tags : <span className={styles.muted}>—</span>;
        },
    },
];

// WK-189 - /admin "Пользователи". Visible only to accounts the backend
// accepts as admin (requireAdmin on /api/admin/*): an ordinary user gets a
// 403 from the API and sees "Доступ запрещён", not an empty table.
export const AdminUsersListPage = () => {
    const router = useRouter();
    const { status } = useStreamSession();
    const { users, total, loading, error, errorStatus, query, setQuery, page, pageSize, setPage, sort, setSort } =
        useAdminUsers();
    const [stats, setStats] = useState<AdminUsageStats | null>(null);
    const [statsFailed, setStatsFailed] = useState(false);

    useEffect(() => {
        if (status === "guest") router.replace("/stream/login?next=/admin");
    }, [status, router]);

    useEffect(() => {
        if (status !== "user") return;
        let cancelled = false;
        adminUsersApi
            .usageStats()
            .then((value) => !cancelled && setStats(value))
            .catch(() => !cancelled && setStatsFailed(true));
        return () => {
            cancelled = true;
        };
    }, [status]);

    if (status !== "user") {
        return <div className={styles.page}><p className={styles.muted} role="status">Загрузка…</p></div>;
    }

    if (errorStatus === 403) {
        return (
            <div className={styles.page}>
                <h1 className={styles.title}>Доступ запрещён</h1>
                <p className={styles.lead}>Этот раздел доступен только администраторам.</p>
            </div>
        );
    }

    return (
        <div className={styles.page}>
            <header className={styles.header}>
                <h1 className={styles.title}>Пользователи</h1>
                <p className={styles.lead}>
                    Активность — по сигналам запущенного Companion{stats?.trackingSince ? ` с ${formatDay(stats.trackingSince)}` : ""}.
                    Сайт посещения не считает.
                </p>
            </header>

            <dl className={styles.stats} aria-label="Сводка">
                {[
                    ["Всего зарегистрировано", stats?.registeredUsers],
                    ["Активны за 7 дней", stats?.wau],
                    ["Активны за 30 дней", stats?.mau],
                ].map(([label, value]) => (
                    <div key={label as string} className={styles.stat}>
                        <dt>{label}</dt>
                        <dd>{value ?? (statsFailed ? "—" : "…")}</dd>
                    </div>
                ))}
            </dl>
            {statsFailed && <p className={styles.error} role="alert">Не удалось загрузить сводку.</p>}

            <ConfigProvider
                theme={{
                    algorithm: theme.darkAlgorithm,
                    token: { colorBgContainer: "#1a1d23", colorBorderSecondary: "#272b33", colorPrimary: "#a4b8fb", borderRadius: 8 },
                }}
            >
                <Input.Search
                    placeholder="Поиск по email"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    allowClear
                    className={styles.search}
                    aria-label="Поиск по email"
                />
                {error && <p className={styles.error} role="alert">{error}</p>}
                <Table<AdminUserSummary>
                    className={styles.table}
                    rowKey="id"
                    columns={buildColumns(sort)}
                    dataSource={users}
                    loading={loading}
                    scroll={{ x: 900 }}
                    onChange={(_, __, sorter) => {
                        const { columnKey, order } = sorter as SorterResult<AdminUserSummary>;
                        const next = order ? SORTS[String(columnKey)]?.[order] : undefined;
                        setSort(next ?? "created_desc");
                    }}
                    pagination={{
                        current: page,
                        pageSize,
                        total,
                        onChange: setPage,
                        showSizeChanger: false,
                        showTotal: (count) => `Всего: ${count}`,
                    }}
                />
            </ConfigProvider>
        </div>
    );
};
