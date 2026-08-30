import type { LocalSessionSummary } from "../types";
import { RecentMatchesWidget } from "../widgets/RecentMatchesWidget";
import { SessionWidget } from "../widgets/SessionWidget";
import styles from "./between-matches-scene.module.scss";

export function BetweenMatchesScene({ session }: { session: LocalSessionSummary }) {
  const hasRecentMatches = session.recentMatches.some((match) => match.result !== null);

  return (
    <section className={styles.scene} aria-label="Между матчами">
      <div className={styles.title}>
        <span>МЕЖДУ</span>
        <strong>МАТЧАМИ</strong>
      </div>
      <div className={styles.hudRow}>
        <SessionWidget session={session} betweenMatches />
        {hasRecentMatches ? (
          <div className={styles.recent}>
            <span className={styles.caption}>ПОСЛЕДНИЕ МАТЧИ</span>
            <RecentMatchesWidget matches={session.recentMatches} betweenMatches />
          </div>
        ) : (
          <div className={styles.empty} aria-label="Нет завершённых матчей">
            <span>ИСТОРИЯ МАТЧЕЙ</span>
            <small>Результат появится после завершения матча</small>
          </div>
        )}
      </div>
    </section>
  );
}
