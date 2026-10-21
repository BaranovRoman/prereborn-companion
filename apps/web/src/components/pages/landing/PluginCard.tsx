import Image from "next/image";
import type { CatalogPlugin } from "@/entities/plugin-catalog";
import styles from "./index.module.scss";

// Icons shipped inside the plugin packages (plugins/<dir>/ui/public/icon.png).
// A plugin without one here gets a monogram, so a new catalog entry still renders.
const ICONS: Record<string, string> = { dota2: "/landing/plugins/dota2.png", pubg: "/landing/plugins/pubg.png" };

export const PluginCard = ({ plugin }: { plugin: CatalogPlugin }) => (
  <li className={styles.plugin}>
    <div className={styles.pluginHead}>
      {ICONS[plugin.id] ? (
        <Image className={styles.pluginIcon} src={ICONS[plugin.id]} alt="" width={44} height={44} />
      ) : (
        <span className={styles.pluginIcon} aria-hidden="true">{plugin.name.slice(0, 1).toUpperCase()}</span>
      )}
      <div>
        <h3>{plugin.name}</h3>
        <p className={styles.pluginVersion}>Версия {plugin.version}</p>
      </div>
      <span className={styles.badge}>Доступен в Companion</span>
    </div>
    {plugin.description ? <p>{plugin.description}</p> : null}
  </li>
);
