import Image from "next/image";
import Link from "next/link";
import type { ChangelogItem } from "@/entities/changelog/load";
import type { PluginCatalogResult } from "@/entities/plugin-catalog";
import { DownloadButton, PublicShell } from "@/components/public-site/PublicShell";
import { ChangelogCard } from "@/components/pages/changelog/ChangelogCard";
import { DOTA_COMPANION_VERSION } from "@/shared/config/dota-companion";
import { PluginCard } from "./PluginCard";
import { UsageStats } from "./UsageStats";
import styles from "./index.module.scss";

// WK-188 - public landing of Prereborn Companion. Capabilities are the ones
// the published Companion exposes (apps/companion core shell on the release
// branch); plugins, versions and updates come from published data only.
const features = [
  ["Twitch-чат", "Сообщения канала в приложении: последние — на «Обзоре», весь чат — на отдельном экране. Twitch подключается через браузер, без ручных токенов."],
  ["Озвучка сообщений", "Чат читается вслух локальным голосом Silero, который работает офлайн, или системным голосом Windows. Ссылки и явный спам пропускаются, озвучку можно пропустить горячей клавишей."],
  ["Словарь произношений", "Свои правила, как читать слова и ники, — для всех или для конкретного зрителя. Результат можно проверить и прослушать, сообщения в чате не меняются."],
  ["Клипы Twitch", "Клип текущей трансляции одной клавишей, даже когда открыта игра. Длительность — от 5 до 60 секунд, ссылка приходит уведомлением."],
  ["Подключение к OBS", "Companion подключается к OBS по WebSocket и показывает, идёт ли трансляция. Сцены переключаются плагинами, только если вы разрешили автоматизацию."],
  ["Игровые плагины", "Игровые функции — отдельные плагины из библиотеки внутри Companion. Ставьте только нужные: пакеты подписаны и обновляются из официального каталога."],
] as const;

const steps = [
  ["Скачайте и установите", <>Установщик для Windows. Дальше Companion обновляется сам — через встроенный подписанный updater.</>],
  ["Войдите и подключите Twitch", <>Войдите аккаунтом Prereborn (нет аккаунта — <Link href="/stream/register">зарегистрируйтесь</Link>), затем «Настройки → Интеграции → Twitch». Авторизация откроется в браузере.</>],
  ["Настройте озвучку, клипы и OBS", <>Выберите голос и устройство вывода, задайте клавишу клипа и при необходимости подключите OBS WebSocket.</>],
  ["Установите игровые плагины", <>В разделе «Плагины» выберите нужные. Каждый плагин можно запускать вместе с Companion.</>],
] as const;

type LandingPageProps = { catalog: PluginCatalogResult; highlight: ChangelogItem | null };

export const LandingPage = ({ catalog, highlight }: LandingPageProps) => (
  <PublicShell>
    <section className={styles.hero} aria-labelledby="hero-title">
      <div className={styles.heroText}>
        <p className={styles.eyebrow}>Приложение для стримеров · Windows</p>
        <h1 id="hero-title">Prereborn Companion</h1>
        <p className={styles.lead}>
          Twitch-чат с озвучкой сообщений, клипы по горячей клавише, подключение к OBS и игровые плагины — статистика матчей, игровые события и виджеты для эфира.
        </p>
        <div className={styles.actions}>
          <DownloadButton />
          <a className={styles.secondary} href="#features">Возможности и плагины</a>
        </div>
        <p className={styles.meta}>
          {DOTA_COMPANION_VERSION ? <>Версия {DOTA_COMPANION_VERSION} · </> : null}Windows x64 · <Link href="/changelog">Что нового</Link>
        </p>
      </div>
      <figure className={styles.heroShot}>
        <Image src="/landing/companion-chat.webp" alt="Окно Prereborn Companion: Twitch-чат и панель управления озвучкой" width={1920} height={1200} priority sizes="(max-width: 1280px) 100vw, 1200px" />
      </figure>
    </section>

    <UsageStats />

    <section id="features" className={styles.section} aria-labelledby="features-title">
      <div className={styles.heading}>
        <h2 id="features-title">Что умеет Companion</h2>
        <p>Основное — в самом приложении. Всё, что связано с конкретной игрой, — в плагинах.</p>
      </div>
      <div className={styles.features}>
        {features.map(([title, text]) => (
          <article key={title} className={styles.feature}>
            <h3>{title}</h3>
            <p>{text}</p>
          </article>
        ))}
      </div>
      <div className={styles.shots}>
        <figure>
          <Image src="/landing/companion-speech.webp" alt="Раздел «Озвучка»: устройство вывода, голос и словарь произношений" width={1920} height={1200} sizes="(max-width: 900px) 100vw, 600px" />
          <figcaption>Озвучка: голос, громкость и словарь произношений</figcaption>
        </figure>
        <figure>
          <Image src="/landing/companion-settings.webp" alt="Раздел «Настройки»: аккаунт, интеграции и клипы Twitch" width={1920} height={1200} sizes="(max-width: 900px) 100vw, 600px" />
          <figcaption>Настройки: интеграции и клипы Twitch</figcaption>
        </figure>
      </div>
    </section>

    <section id="plugins" className={styles.section} aria-labelledby="plugins-title">
      <div className={styles.heading}>
        <h2 id="plugins-title">Игровые плагины</h2>
        <p>Список берётся из официального каталога — того же, из которого плагины устанавливает Companion. Установка: Companion → «Плагины».</p>
      </div>
      {catalog.ok && catalog.plugins.length ? (
        <ul className={styles.plugins}>
          {catalog.plugins.map((plugin) => <PluginCard key={plugin.id} plugin={plugin} />)}
        </ul>
      ) : (
        <p className={styles.notice} role="status">
          {catalog.ok ? "В каталоге пока нет плагинов." : "Не удалось загрузить каталог плагинов. Актуальный список всегда есть в Companion, в разделе «Плагины»."}
        </p>
      )}
    </section>

    <section id="start" className={styles.section} aria-labelledby="start-title">
      <div className={styles.heading}>
        <h2 id="start-title">Как начать</h2>
      </div>
      <ol className={styles.steps}>
        {steps.map(([title, text], index) => (
          <li key={title}>
            <span className={styles.stepNumber} aria-hidden="true">{index + 1}</span>
            <h3>{title}</h3>
            <p>{text}</p>
          </li>
        ))}
      </ol>
    </section>

    {highlight ? (
      <section className={styles.section} aria-labelledby="update-title">
        <div className={styles.headingRow}>
          <h2 id="update-title">Последнее обновление</h2>
          <Link className={styles.more} href="/changelog">Вся история обновлений →</Link>
        </div>
        <ChangelogCard item={highlight} headingLevel={3} />
      </section>
    ) : null}

    <section className={styles.final} aria-labelledby="final-title">
      <h2 id="final-title">Попробуйте Companion на своём эфире</h2>
      <p>Последняя стабильная версия для Windows. Следующие обновления придут прямо в приложение.</p>
      <div className={styles.actions}>
        <DownloadButton />
        <Link className={styles.secondary} href="/stream/login">Уже есть аккаунт — войти</Link>
      </div>
    </section>
  </PublicShell>
);
