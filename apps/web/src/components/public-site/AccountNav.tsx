"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { streamAuthApi } from "@/entities/stream-user/api/stream-auth";
import { useStreamSession } from "@/entities/stream-user/lib/use-stream-session";
import styles from "./public-site.module.scss";

// WK-189 - the session-aware part of the public header and footer. The
// session is client-only, so until it is known the header keeps an empty
// slot of the same size instead of flashing "Войти" at a signed-in user.
export const AccountNav = ({ placement }: { placement: "header" | "footer" }) => {
  const router = useRouter();
  const { status, user } = useStreamSession();
  const [signingOut, setSigningOut] = useState(false);

  const signOut = async () => {
    setSigningOut(true);
    await streamAuthApi.logout();
    setSigningOut(false);
    router.refresh();
  };

  if (status === "checking") {
    return placement === "header" ? <span className={styles.navPending} aria-hidden="true" data-testid="account-nav-pending" /> : null;
  }

  if (status === "guest" || !user) {
    return (
      <>
        <Link href="/stream/login">Войти</Link>
        <Link className={placement === "header" ? styles.navSection : undefined} href="/stream/register">Регистрация</Link>
      </>
    );
  }

  return (
    <>
      <Link href="/account">Личный кабинет</Link>
      {user.isAdmin && <Link className={placement === "header" ? styles.navSection : undefined} href="/admin">Администрирование</Link>}
      <button type="button" className={styles.navButton} onClick={signOut} disabled={signingOut}>
        Выйти
      </button>
    </>
  );
};
