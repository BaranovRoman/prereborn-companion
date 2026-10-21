import type { ChangelogFeed as Feed } from "@/entities/changelog/load";
import { PublicShell } from "@/components/public-site/PublicShell";
import { COMPANION_REPO_URL } from "@/shared/config/product-sources";
import { ChangelogFeed } from "./ChangelogFeed";
import styles from "./changelog.module.scss";

// WK-188 - user-facing history of Companion and plugin releases, read from
// the changelog files on the release branch (changelog/README.md).
export const ChangelogPage = ({ feed }: { feed: Feed }) => (
  <PublicShell>
    <div className={styles.page}>
      <header className={styles.intro}>
        <h1>История обновлений</h1>
        <p>Что изменилось в Prereborn Companion и игровых плагинах — от новых к старым.</p>
      </header>
      {!feed.complete ? (
        <p className={styles.notice} role="status">
          {feed.items.length ? "Часть истории сейчас не загрузилась. Обновите страницу позже." : "Не удалось загрузить историю обновлений. Обновите страницу позже."}
        </p>
      ) : null}
      {feed.items.length ? <ChangelogFeed items={feed.items} products={feed.products} /> : feed.complete ? <p className={styles.notice}>Записей пока нет.</p> : null}
      <p className={styles.footnote}>
        История на этой странице ведётся с версии Companion 0.6.0. Технические заметки более ранних версий — в{" "}
        <a href={`${COMPANION_REPO_URL}/releases`} rel="noopener">релизах на GitHub</a>.
      </p>
    </div>
  </PublicShell>
);
