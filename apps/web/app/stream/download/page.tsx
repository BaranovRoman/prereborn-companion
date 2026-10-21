import type { Metadata } from "next";
import { StreamDownloadPage } from "@/components/pages/stream/download";

export const metadata: Metadata = {
    title: "Скачать",
    description:
        "Prereborn Companion для Windows: Twitch-чат с озвучкой, клипы, подключение к OBS и игровые плагины.",
    robots: { index: false, follow: false },
};

export default function StreamDownload() {
    return <StreamDownloadPage />;
}
