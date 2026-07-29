import type { Metadata } from "next";
import { OverlayPage } from "@/components/pages/overlay";
import { getOverlayData } from "@/entities/stream-session/api/overlay-server";

// Публичная страница без авторизации, открывается напрямую в OBS Browser
// Source - как /story и другие app/*/page.tsx, backend недоступен на этапе
// сборки, поэтому force-dynamic вместо статической генерации.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
    title: "Overlay",
    robots: { index: false, follow: false },
};

interface OverlayRouteProps {
    params: Promise<{ publicToken: string }>;
    searchParams: Promise<{ debug?: string; scale?: string }>;
}

export default async function Overlay({ params, searchParams }: OverlayRouteProps) {
    const { publicToken } = await params;
    const query = await searchParams;
    const initialData = await getOverlayData(publicToken);

    // Debug-панель - только по явному query-параметру, никогда по умолчанию
    // (см. задачу, п.5): публичный overlay-URL не должен молча раскрывать
    // debug-режим всем, у кого он есть.
    const debug = query.debug === "1";
    const parsedScale = query.scale ? Number(query.scale) : NaN;
    const scale =
        Number.isFinite(parsedScale) && parsedScale > 0 ? parsedScale : undefined;

    return (
        <OverlayPage
            publicToken={publicToken}
            initialData={initialData}
            debug={debug}
            scale={scale}
        />
    );
}
