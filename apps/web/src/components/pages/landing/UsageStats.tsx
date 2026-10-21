"use client";
import { useEffect, useState } from "react";
import styles from "./index.module.scss";

// WK-186 - real Companion usage, computed server-side from Companion
// heartbeats (docs/analytics/companion-usage-stats.md). The site only reads
// the aggregate; it tracks nothing itself. Renders nothing while loading or
// on any error - never zeros or placeholder numbers. While less than 30 days
// of history exist, the caption says when collection started so the 7d/30d
// numbers aren't read as a full observation window.
export type PublicUsageStats = { registeredUsers: number; activeUsers7d: number; activeUsers30d: number; trackingSince: string | null; generatedAt: string };

const FULL_HISTORY_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const isIsoDay = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

export const parsePublicUsageStats = (body: unknown): PublicUsageStats | null => {
  if (!body || typeof body !== "object") return null;
  const { registeredUsers, activeUsers7d, activeUsers30d, trackingSince, generatedAt } = body as Record<string, unknown>;
  if (!isCount(registeredUsers) || !isCount(activeUsers7d) || !isCount(activeUsers30d)) return null;
  if (trackingSince !== null && !isIsoDay(trackingSince)) return null;
  if (typeof generatedAt !== "string" || Number.isNaN(Date.parse(generatedAt))) return null;
  return { registeredUsers, activeUsers7d, activeUsers30d, trackingSince, generatedAt };
};

const formatCount = new Intl.NumberFormat("ru-RU");
const formatDay = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** Caption while the 30-day window isn't fully covered yet; null once it is. */
export const collectionCaption = ({ trackingSince, generatedAt }: PublicUsageStats): string | null => {
  if (!trackingSince) return "Статистика активности только начала собираться.";
  const since = Date.parse(`${trackingSince}T00:00:00Z`);
  if (Date.parse(generatedAt) - since >= FULL_HISTORY_DAYS * DAY_MS) return null;
  // ru-RU long dates already end with "г.", which closes the sentence.
  return `Статистика собирается с ${formatDay.format(since)}`;
};

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
  const caption = collectionCaption(stats);
  return <section className={styles.stats} aria-label="Статистика Companion"><dl>{items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{formatCount.format(value)}</dd></div>)}</dl><small>Активность считается по запускам desktop-приложения Companion.{caption ? ` ${caption}` : ""}</small></section>;
};
