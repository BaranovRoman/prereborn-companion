import type { Metadata } from "next";
import { StreamDownloadPage } from "@/components/pages/stream/download";

export const metadata: Metadata = {
    title: "Скачать Dota Companion — Stream",
    description:
        "Desktop-приложение для Windows, передающее состояние матча Dota 2 в стрим-оверлей.",
    robots: { index: false, follow: false },
};

export default function StreamDownload() {
    return <StreamDownloadPage />;
}
