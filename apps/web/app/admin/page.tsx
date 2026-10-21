import type { Metadata } from "next";
import { PublicShell } from "@/components/public-site/PublicShell";
import { AdminUsersListPage } from "@/components/pages/admin/users-list";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
    title: "Пользователи — администрирование",
    robots: { index: false, follow: false },
};

export default function AdminRoute() {
    return (
        <PublicShell>
            <AdminUsersListPage />
        </PublicShell>
    );
}
