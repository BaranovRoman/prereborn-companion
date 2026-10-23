import Image from "next/image";
import Link from "next/link";
import { Inter } from "next/font/google";
import type { ReactNode } from "react";
import { DOTA_COMPANION_DOWNLOAD_URL } from "@/shared/config/dota-companion";
import { COMPANION_LATEST_RELEASE_URL, COMPANION_REPO_URL } from "@/shared/config/product-sources";
import { PRIVACY_PATH, TERMS_PATH } from "@/shared/config/legal";
import { AccountNav } from "./AccountNav";
import { TermsNotice } from "./TermsNotice";
import styles from "./public-site.module.scss";

// WK-188 - frame of the public pages (landing, /changelog), styled after the
// Companion desktop UI (apps/companion components/ui/ui.css tokens).
const inter = Inter({ subsets: ["latin", "cyrillic"], display: "swap" });

/**
 * The stable Windows installer resolved at build time from GitHub's "latest"
 * release (scripts/resolve-companion-release.sh, refreshed by every Companion
 * release). Without it, GitHub's latest-release page still offers the installer.
 */
export const companionDownloadHref = DOTA_COMPANION_DOWNLOAD_URL ?? COMPANION_LATEST_RELEASE_URL;

export const DownloadButton = ({ size = "large", label = "Скачать для Windows" }: { size?: "large" | "small"; label?: string }) => (
  <a className={`${styles.button} ${styles.buttonPrimary} ${size === "small" ? styles.buttonSmall : ""}`} href={companionDownloadHref} rel="noopener">
    <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M8 1.5a.75.75 0 0 1 .75.75v6.69l2.22-2.22a.75.75 0 1 1 1.06 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 0 1 1.06-1.06l2.22 2.22V2.25A.75.75 0 0 1 8 1.5ZM2.75 12.5a.75.75 0 0 0 0 1.5h10.5a.75.75 0 0 0 0-1.5H2.75Z" /></svg>
    {label}
  </a>
);

export const PublicShell = ({ children }: { children: ReactNode }) => (
  <div className={`${styles.site} ${inter.className} publicSite`}>
    <a className={styles.skip} href="#content">К содержимому</a>
    <header className={styles.header}>
      <div className={styles.headerInner}>
        <Link href="/" className={styles.brand} aria-label="Prereborn Companion — главная">
          <Image src="/companion-icon.png" alt="" width={32} height={32} priority />
          <span>Prereborn <small>Companion</small></span>
        </Link>
        <nav className={styles.nav} aria-label="Разделы сайта">
          <Link className={styles.navSection} href="/#features">Возможности</Link>
          <Link className={styles.navSection} href="/#plugins">Плагины</Link>
          <Link href="/changelog">Обновления</Link>
          <AccountNav placement="header" />
        </nav>
        <span className={styles.headerDownload}><DownloadButton size="small" label="Скачать" /></span>
      </div>
    </header>
    <main id="content" className={styles.main}>
      <TermsNotice />
      {children}
    </main>
    <footer className={styles.footer}>
      <div className={styles.footerInner}>
        <span>Prereborn Companion — приложение для стримеров на Windows</span>
        <nav aria-label="Ссылки в подвале">
          <Link href="/changelog">История обновлений</Link>
          <a href={COMPANION_REPO_URL} rel="noopener">GitHub</a>
          <Link href={TERMS_PATH}>Пользовательское соглашение</Link>
          <Link href={PRIVACY_PATH}>Политика обработки данных</Link>
          <AccountNav placement="footer" />
        </nav>
      </div>
    </footer>
  </div>
);
