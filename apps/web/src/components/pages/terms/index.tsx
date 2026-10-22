import Link from "next/link";
import { PublicShell } from "@/components/public-site/PublicShell";
import { formatLegalDate, isLegalDocumentPublished, LEGAL_OPERATOR, PRIVACY_PATH, type LegalOperatorDetails } from "@/shared/config/legal";
import styles from "../privacy/privacy.module.scss";

// WK-191 - user agreement (public offer) from docs/legal/user-agreement-draft.md.
// It is the contract that the account-related processing in /privacy rests on
// (п. 5 ч. 1 ст. 6 152-ФЗ); accepting it is the "Создать аккаунт" button, and it
// carries no consent to personal-data processing (ч. 1 ст. 9: consent would have
// to be a separate document). Viewers' and donors' data stay with the current
// model: the operator processes them on its own basis (п. 7), no commission.

export const TermsPage = ({ operator = LEGAL_OPERATOR }: { operator?: LegalOperatorDetails }) => {
  const published = isLegalDocumentPublished(operator);
  const effectiveDate = formatLegalDate(operator.effectiveDate);
  const contact = operator.contactEmail ? <a href={`mailto:${operator.contactEmail}`}>{operator.contactEmail}</a> : null;

  return (
    <PublicShell>
      <article className={styles.page}>
        <header className={styles.intro}>
          <h1>Пользовательское соглашение</h1>
          <p>Условия, на которых вы пользуетесь Prereborn Companion.</p>
          <p className={styles.meta}>Действует с: {effectiveDate ?? "даты публикации"}</p>
        </header>

        {!published ? (
          <p className={styles.draft} role="note">
            Черновик: документ ещё не опубликован и не вступил в силу.
          </p>
        ) : null}

        <section className={styles.section}>
          <h2>1. Общие положения</h2>
          <p>
            Это соглашение заключается между {operator.operatorName ?? "владельцем проекта"} (физическое лицо,
            далее — «администратор») и человеком, который создал учётную запись (далее — «пользователь»). Оно
            действует для сервиса Prereborn Companion: сайта prereborn.ru, его серверной части (API),
            desktop-приложения Companion с игровыми плагинами и Twitch-расширения (далее — «сервис»).
          </p>
          <p>
            Соглашение — публичная оферта (ст. 437 ГК РФ). Нажимая «Создать аккаунт» на странице регистрации,
            вы принимаете его целиком (ст. 438 ГК РФ).
          </p>
          <p>Сервис бесплатный: платных функций в нём нет.</p>
        </section>

        <section className={styles.section}>
          <h2>2. Учётная запись</h2>
          <ul>
            <li>Для регистрации нужны только адрес электронной почты и пароль.</li>
            <li>
              Вы отвечаете за сохранность пароля и за действия, совершённые через вашу учётную запись,
              приложение Companion и ссылку на оверлей.
            </li>
            <li>
              Вы можете в любой момент перестать пользоваться сервисом и попросить удалить учётную запись —
              порядок описан в <Link href={PRIVACY_PATH}>политике обработки персональных данных</Link>.
            </li>
          </ul>
        </section>

        <section className={styles.section}>
          <h2>3. Что делает сервис</h2>
          <p>
            Сервис ведёт статистику игровых сессий, показывает оверлеи и экраны стрима, озвучивает и показывает
            чат Twitch, присылает оповещения о подписках, фолловах и донатах, создаёт клипы, проводит викторины
            для зрителей и работает с игровыми плагинами.
          </p>
          <p>
            Часть функций работает только после того, как вы сами подключите Twitch, Steam или DonationAlerts.
            Отключить их можно в любой момент. Отношения с этими сервисами регулируются их собственными правилами.
          </p>
          <p>
            Подключая викторину и донаты к своему стриму, вы показываете зрителям имена участников и авторов
            донатов. Используйте эти функции только для своего стрима и не собирайте с их помощью данные зрителей
            для других целей.
          </p>
        </section>

        <section className={styles.section}>
          <h2>4. Персональные данные</h2>
          <p>
            Администратор обрабатывает ваши персональные данные, чтобы заключить и исполнить это соглашение
            (п. 5 ч. 1 ст. 6 Федерального закона № 152-ФЗ «О персональных данных»). Какие данные, зачем,
            где и сколько хранятся — в <Link href={PRIVACY_PATH}>политике обработки персональных данных</Link>.
          </p>
          <p>
            Мы не используем ваши данные для рекламы и рассылок. Если такие цели появятся, они будут доступны
            только с вашего отдельного согласия и не станут условием пользования сервисом.
          </p>
        </section>

        <section className={styles.section}>
          <h2>5. Ответственность</h2>
          <p>
            Сервис предоставляется «как есть». Администратор старается, чтобы он работал без перебоев, но не может
            гарантировать этого, в том числе для Twitch, Steam, DonationAlerts, OpenDota и PUBG API, от которых
            зависят отдельные функции.
          </p>
        </section>

        <section className={styles.section}>
          <h2>6. Изменение и прекращение соглашения</h2>
          <ul>
            <li>
              Администратор может изменить соглашение. Новая редакция публикуется на этой странице с датой
              вступления в силу. Если вы не согласны с ней, вы можете перестать пользоваться сервисом и удалить
              учётную запись.
            </li>
            <li>
              Администратор может ограничить доступ к сервису, если учётная запись используется с нарушением
              соглашения или закона.
            </li>
            <li>Соглашение прекращается после удаления учётной записи.</li>
          </ul>
        </section>

        <section className={styles.section}>
          <h2>7. Применимое право</h2>
          <p>
            К соглашению применяется право Российской Федерации. Споры разрешаются в порядке, установленном
            законодательством Российской Федерации.
          </p>
        </section>

        <section className={styles.section}>
          <h2>8. Контакты</h2>
          <dl className={styles.operator}>
            <dt>Администратор</dt>
            <dd>{operator.operatorName ?? "—"}</dd>
            <dt>Электронная почта</dt>
            <dd>{contact ?? "—"}</dd>
          </dl>
        </section>
      </article>
    </PublicShell>
  );
};
