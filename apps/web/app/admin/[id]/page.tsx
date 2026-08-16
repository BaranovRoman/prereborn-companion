import type { Metadata } from "next";
import { AdminUserDetailPage } from "@/components/pages/admin/user-detail";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
    title: "Пользователь — Admin",
    robots: { index: false, follow: false },
};

interface AdminUserRouteProps {
    params: Promise<{ id: string }>;
}

export default async function AdminUserRoute({ params }: AdminUserRouteProps) {
    const { id } = await params;
    return <AdminUserDetailPage id={id} />;
}
