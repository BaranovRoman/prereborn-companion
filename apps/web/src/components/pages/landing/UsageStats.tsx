"use client";
import { useEffect, useState } from "react";
import styles from "./index.module.scss";

// WK-186 - real Companion usage, computed server-side from Companion
// heartbeats (docs/analytics/companion-usage-stats.md). The site only reads
// the aggregate; it tracks nothing itself. Renders nothing while loading,
// on any error, or until the server marks the stats as ready - never zeros
// or placeholder numbers.
export type PublicUsageStats = { registeredUsers: number; activeUsers7d: number; activeUsers30d: number; ready: boolean };

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

export const parsePublicUsageStats = (body: unknown): PublicUsageStats | null => {
  if (!body || typeof body !== "object") return null;
  const { registeredUsers, activeUsers7d, activeUsers30d, ready } = body as Record<string, unknown>;
  if (ready !== true || !isCount(registeredUsers) || !isCount(activeUsers7d) || !isCount(activeUsers30d) || registeredUsers === 0) return null;
  return { registeredUsers, activeUsers7d, activeUsers30d, ready };
};

const format = new Intl.NumberFormat("ru-RU");

export const UsageStats = () => {
  const [stats, setStats] = useState<PublicUsageStats | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/public/usage-stats", { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => setStats(parsePublicUsageStats(body)))
      .catch(() => setStats(null));
    return () => controller.abort();
  }, []);
  if (!stats) return null;
  const items: [string, number][] = [["Зарегистрировано пользователей", stats.registeredUsers], ["Активны за 7 дней", stats.activeUsers7d], ["Активны за 30 дней", stats.activeUsers30d]];
  return <section className={styles.stats} aria-label="Статистика Companion"><dl>{items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{format.format(value)}</dd></div>)}</dl><small>Активность считается по запускам desktop-приложения Companion.</small></section>;
};
