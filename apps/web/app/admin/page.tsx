import type { Metadata } from "next";
import { AdminUsersListPage } from "@/components/pages/admin/users-list";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
    title: "Admin",
    robots: { index: false, follow: false },
};

export default function AdminRoute() {
    return <AdminUsersListPage />;
}
