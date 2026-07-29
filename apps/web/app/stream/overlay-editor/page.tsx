import type { Metadata } from "next";
import { OverlayEditorPage } from "@/components/pages/stream/overlay-editor";

// Тот же паттерн, что и app/stream/page.tsx - целиком клиентская
// авторизованная страница, статический prerender ей не нужен.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
    title: "Раскладка оверлея — Stream",
    robots: { index: false, follow: false },
};

export default function StreamOverlayEditor() {
    return <OverlayEditorPage />;
}
