import type { ChangelogItem } from "@/entities/changelog/load";
import { CHANGELOG_SECTIONS } from "@/entities/changelog/parse";
import styles from "./changelog.module.scss";

const formatDay = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
export const formatChangelogDate = (day: string) => formatDay.format(new Date(`${day}T00:00:00Z`));

export const changelogAnchor = (item: Pick<ChangelogItem, "product" | "version">) => `${item.product.id}-${item.version.replace(/\./g, "-")}`;

export const ChangelogCard = ({ item, headingLevel = 2 }: { item: ChangelogItem; headingLevel?: 2 | 3 }) => {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const Section = headingLevel === 2 ? "h3" : "h4";
  return (
    <article className={styles.card} id={changelogAnchor(item)}>
      <p className={styles.cardMeta}>
        <span className={item.product.kind === "companion" ? styles.productCompanion : styles.productPlugin}>{item.product.kind === "companion" ? "Companion" : `Плагин ${item.product.name}`}</span>
        <span className={styles.version}>Версия {item.version}</span>
        <time dateTime={item.date}>{formatChangelogDate(item.date)}</time>
      </p>
      <Heading className={styles.cardTitle}>{item.title}</Heading>
      {item.summary ? <p className={styles.summary}>{item.summary}</p> : null}
      {CHANGELOG_SECTIONS.map((name) => {
        const list = item.sections[name];
        if (!list?.length) return null;
        return (
          <div key={name} className={styles.group}>
            <Section>{name}</Section>
            <ul>{list.map((line) => <li key={line}>{line}</li>)}</ul>
          </div>
        );
      })}
    </article>
  );
};
