import type { Metadata } from "next";
import { Suspense } from "react";
import { PublicShell } from "@/components/public-site/PublicShell";
import { AccountPage } from "@/components/pages/account";

// WK-189 - the account page replaces the old /stream settings cabinet. The
// session is client-only (localStorage tokens), so nothing here prerenders
// user data; Suspense is required by useSearchParams (callback notices).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Личный кабинет",
  robots: { index: false, follow: false },
};

export default function AccountRoute() {
  return (
    <PublicShell>
      <Suspense fallback={null}>
        <AccountPage />
      </Suspense>
    </PublicShell>
  );
}
