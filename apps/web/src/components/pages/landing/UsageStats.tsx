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

const LABELS = ["Зарегистрировано пользователей", "Активны за 7 дней", "Активны за 30 дней"] as const;

// WK-188 - "loading" keeps the block's height (no layout jump); "error" says
// so in words instead of disappearing or showing zeros.
type State = { status: "loading" } | { status: "error" } | { status: "ready"; stats: PublicUsageStats };

export const UsageStats = () => {
  const [state, setState] = useState<State>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/public/usage-stats", { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        const stats = parsePublicUsageStats(body);
        setState(stats ? { status: "ready", stats } : { status: "error" });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: "error" });
      });
    return () => controller.abort();
  }, []);
  if (state.status === "error") {
    return <section className={styles.stats} aria-label="Статистика Companion"><small role="status">Статистика Companion сейчас недоступна.</small></section>;
  }
  const stats = state.status === "ready" ? state.stats : null;
  const values = stats ? [stats.registeredUsers, stats.activeUsers7d, stats.activeUsers30d] : null;
  const caption = stats ? collectionCaption(stats) : null;
  return (
    <section className={styles.stats} aria-label="Статистика Companion" aria-busy={!stats}>
      <dl>
        {LABELS.map((label, index) => (
          <div key={label}>
            <dt>{label}</dt>
            {values ? <dd>{formatCount.format(values[index])}</dd> : <dd aria-hidden="true"><span className={styles.statsPlaceholder} /></dd>}
          </div>
        ))}
      </dl>
      <small>Активность считается по запускам desktop-приложения Companion.{caption ? ` ${caption}` : ""}</small>
    </section>
  );
};
