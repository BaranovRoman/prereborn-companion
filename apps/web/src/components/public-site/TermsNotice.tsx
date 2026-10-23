"use client";

import Link from "next/link";
import { useState } from "react";
import { streamAuthApi } from "@/entities/stream-user/api/stream-auth";
import { useStreamSession } from "@/entities/stream-user/lib/use-stream-session";
import { ACCOUNT_PATH, LEGAL_OPERATOR, PRIVACY_PATH, TERMS_PATH } from "@/shared/config/legal";
import styles from "./public-site.module.scss";

// WK-191 - asks a signed-in account that hasn't accepted the user agreement
// in force (created before it was published, or a new edition) to accept it.
// It is a banner, not a modal: the header's "Выйти" and the account deletion
// on /account stay usable without accepting.
export const TermsNotice = () => {
  const { user } = useStreamSession();
  const [state, setState] = useState<"idle" | "busy" | "stale" | "error" | "done">("idle");
  const version = LEGAL_OPERATOR.effectiveDate;

  if (!version || !user?.terms?.acceptanceRequired || state === "done") return null;

  const accept = async () => {
    setState("busy");
    try {
      await streamAuthApi.acceptTerms(version);
      setState("done");
    } catch (error) {
      const status = (error as { response?: { status?: number } }).response?.status;
      setState(status === 409 ? "stale" : "error");
    }
  };

  return (
    <section className={styles.termsNotice} aria-labelledby="terms-notice-title">
      <div className={styles.termsNoticeInner}>
        <div>
          <h2 id="terms-notice-title">Пользовательское соглашение</h2>
          <p>
            С {formatDate(version)} действуют <Link href={TERMS_PATH}>пользовательское соглашение</Link> и{" "}
            <Link href={PRIVACY_PATH}>политика обработки персональных данных</Link>. Ознакомьтесь с ними и подтвердите,
            что принимаете соглашение. Если вы не согласны, вы можете выйти или{" "}
            <Link href={`${ACCOUNT_PATH}#delete-account`}>удалить аккаунт</Link>.
          </p>
          {state === "stale" && <p role="alert">Соглашение обновилось. Обновите страницу и откройте его ещё раз.</p>}
          {state === "error" && <p role="alert">Не удалось сохранить. Попробуйте ещё раз.</p>}
        </div>
        <button type="button" className={`${styles.button} ${styles.buttonPrimary} ${styles.buttonSmall}`} onClick={accept} disabled={state === "busy"}>
          Принимаю
        </button>
      </div>
    </section>
  );
};

const formatDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
