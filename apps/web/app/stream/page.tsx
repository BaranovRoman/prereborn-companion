import type { Metadata } from "next";
import { Suspense } from "react";
import { StreamSettingsPage } from "@/components/pages/stream/settings";

// StreamSettingsPage читает useSearchParams() (возврат из Steam OpenID
// callback) - без Suspense Next.js падает на build с "useSearchParams()
// should be wrapped in a suspense boundary", тот же паттерн, что и
// app/effects/page.tsx. force-dynamic и так не помешал бы (страница целиком
// клиентская, авторизация по localStorage-токену, статический prerender ей
// не нужен), но именно Suspense - то, что реально требует эта ошибка сборки.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
    title: "Настройки — Stream",
    robots: { index: false, follow: false },
};

export default function Stream() {
    return (
        <Suspense fallback={null}>
            <StreamSettingsPage />
        </Suspense>
    );
}
